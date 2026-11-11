import { describe, expect, it } from 'vitest'
import { MasterFcc0adVersionAdapter } from '../src/versions/master-fcc0ad/adapter.js'
import { MASTER_FCC0AD_COMMIT } from '../src/versions/master-fcc0ad/identity.js'
import { masterFcc0adSessionProfile } from '../src/versions/master-fcc0ad/session-wire.js'
import { masterCatalogFactSchema } from '../src/versions/master-fcc0ad/contracts.js'
import { alpha222SessionProfile } from '../src/versions/alpha222/session-wire.js'
import {
  validAlpha171SessionEvent,
  validAlpha171SessionSnapshot,
} from '../src/versions/alpha171/session-wire.js'
import type { DshTransport } from '../src/contracts.js'
import type { BackendEvent, SessionProjectionValues } from '@dsh-vscode/domain'
import { MasterFcc0adSubagentRepository } from '../src/versions/master-fcc0ad/subagent-repository.js'
import { ProbeFixtureTransport } from './support/probe-fixture.js'
import {
  bodyText,
  candidate,
  endpoint,
  transportOptions,
  wrappedResponse,
} from './support/contract-harness.js'
import { callRpc } from '../src/versions/rc6/rpc.js'
import {
  masterNamedCatalogFact,
  masterNamedChild,
  masterCatalogSnapshot,
  masterTeam,
} from './fixtures/master-fcc0ad-contract.js'

class Adapter extends MasterFcc0adVersionAdapter {
  public normalize(value: unknown): readonly unknown[] | undefined {
    return this.createTransportOptions(endpoint).normalizeControlFrame?.(value)
  }
  public project(values: Readonly<Record<string, unknown>>): SessionProjectionValues {
    return this.mapProjectionValues(values)
  }
  public event(value: BackendEvent): BackendEvent {
    return this.mapBackendEvent(value)
  }
}

describe('commit-scoped master fcc0ad preparation', () => {
  it.each(['fcc0ad4621', '0.2.2-rc.1', '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db'])(
    'rejects insufficient source identity %s before opening a connection',
    (source) => {
      expect(() => new Adapter(transportOptions(globalThis.fetch), source)).toThrow(
        'pinned upstream source commit',
      )
    },
  )

  it('uses an independent exact identity and releases its read-only probe transport', async () => {
    const fixture = new ProbeFixtureTransport()
    class ProbeAdapter extends MasterFcc0adVersionAdapter {
      public override createTransport(): DshTransport {
        return fixture
      }
    }
    const adapter = new ProbeAdapter(transportOptions(globalThis.fetch), MASTER_FCC0AD_COMMIT)
    expect(await adapter.probe(candidate('0.2.2-rc.1'))).toMatchObject({
      adapterId: 'dsh-master-fcc0ad',
      protocolVersion: 'master-fcc0ad',
      dshVersion: '0.2.2-rc.1',
    })
    expect(fixture.closeCalls).toBe(1)
    expect(await adapter.probe(candidate('0.2.2-rc.2'))).toBeUndefined()
    expect(await adapter.probeCompatibility()).toBeUndefined()
    expect(fixture.closeCalls).toBe(1)
  })

  it('isolates catalog v3 and team/mode admission from the released profile', () => {
    const catalog = { type: 'subagent/catalog', seq: 4, time: 1_000, data: masterNamedCatalogFact }
    expect(validAlpha171SessionEvent(catalog, masterFcc0adSessionProfile)).toBe(true)
    expect(validAlpha171SessionEvent(catalog, alpha222SessionProfile)).toBe(false)
    const mode = { type: 'team/mode', seq: 5, time: 1_000, data: { enabled: true } }
    expect(validAlpha171SessionEvent(mode, masterFcc0adSessionProfile)).toBe(true)
    expect(validAlpha171SessionEvent(mode, alpha222SessionProfile)).toBe(false)
    expect(masterFcc0adSessionProfile.normalizeEvent?.(catalog)).toMatchObject({
      type: 'subagent/catalog',
      data: { version: 0, mode: 'continuable' },
    })
    expect(masterFcc0adSessionProfile.normalizeEvent?.(mode)).toMatchObject({
      type: 'system/message',
      data: {},
    })
  })

  it.each(['lead', 'Upper', 'a/b', '', 'a'.repeat(33)])('rejects invalid catalog name %s', (name) => {
    expect(masterCatalogFactSchema.safeParse({ ...masterNamedCatalogFact, name }).success).toBe(false)
  })

  it('restores complete v3 catalog snapshots and rejects conflicting own names and child identities', () => {
    expect(validAlpha171SessionSnapshot(masterCatalogSnapshot, masterFcc0adSessionProfile)).toBe(true)
    expect(validAlpha171SessionSnapshot(masterCatalogSnapshot, alpha222SessionProfile)).toBe(false)
    for (const conflict of [{ name: 'reviewer' }, { childId: 'child' }]) {
      const records = masterCatalogSnapshot.records.map((record) =>
        record.event.seq === 1
          ? { ...record, event: { ...record.event, data: { ...record.event.data, ...conflict } } }
          : record,
      )
      expect(
        validAlpha171SessionSnapshot({ ...masterCatalogSnapshot, records }, masterFcc0adSessionProfile),
      ).toBe(false)
    }
    expect(masterCatalogSnapshot.records[1]?.event.data).toMatchObject({ version: 3, name: 'writer' })
  })

  it('checks sibling-name uniqueness only within the current own suffix', () => {
    const inherited = { type: 'subagent/catalog', seq: 0, time: 1_000, data: masterNamedCatalogFact }
    const marker = { type: 'session/end-seed', seq: 1, time: 1_001, data: { inherited: true } }
    const own = {
      type: 'subagent/catalog',
      seq: 2,
      time: 1_002,
      data: { ...masterNamedCatalogFact, childId: 'own-child' },
    }
    const artifact = {
      header: { ...masterCatalogSnapshot.header, isSeeded: true, parentSession: 'seed-parent' },
      inheritedEventCount: 1,
      events: [inherited, marker, own],
    }
    const known = new Set(['subagent/catalog', 'session/end-seed'])
    expect(() => masterFcc0adSessionProfile.restoreArtifact?.(artifact, known)).not.toThrow()
    expect(own.data).toMatchObject({ version: 3, name: 'reviewer' })
  })

  it('filters child-history projections through the same public boundary as ordinary sessions', async () => {
    let ending = 4
    class HistoryTransport extends ProbeFixtureTransport {
      public override request<TResponse>(method: string): Promise<TResponse> {
        const value =
          method === 'session.list'
            ? { items: [] }
            : {
                events: [],
                hasMore: false,
                projections: {
                  asOfSeq: 5,
                  values: {
                    title: 'Child title',
                    conversationContinuation: ending,
                    agentTeam: { ...masterTeam, failure: 'Private fixture diagnostic' },
                    userQuestions: {
                      active: [
                        {
                          callId: 'question-call',
                          state: 'open',
                          questions: [
                            {
                              id: 'question',
                              question: 'Continue?',
                              detail: 'Fixture detail',
                              header: 'Fixture',
                              options: [{ label: 'Yes', description: 'Continue' }],
                              multiSelect: false,
                            },
                          ],
                        },
                      ],
                      settled: [],
                    },
                  },
                },
              }
        return Promise.resolve({ rpcId: 'fixture', result: { ok: true, value } } as TResponse)
      }
      public override remoteRequest<TResponse>(
        method = '',
        args: Readonly<Record<string, unknown>> = {},
      ): Promise<TResponse> {
        if (method !== 'session/projections')
          return Promise.reject<TResponse>(new Error('Unexpected fixture Remote'))
        const sessionId = (args.request as { sessionId?: string } | undefined)?.sessionId
        return Promise.resolve({
          ok: true,
          value: {
            kind: 'sequenced',
            asOfSeq: 5,
            values: { subagentCatalog: sessionId === 'root' ? [masterNamedChild] : [] },
          },
        } as TResponse)
      }
    }
    const transport = new HistoryTransport()
    const repository = new MasterFcc0adSubagentRepository(transport, {})
    try {
      await repository.list('root')
      const page = await repository.history('child')
      expect(page.projection).toMatchObject({
        asOfSequence: 5,
        values: {
          title: 'Child title',
          conversationContinuation: 4,
          userQuestions: { active: [{ questions: [{ prompt: 'Continue?' }] }] },
        },
      })
      expect(page.projection?.values).not.toHaveProperty('agentTeam')
      expect(JSON.stringify(page)).not.toContain('/fixture/private')
      expect(JSON.stringify(page)).not.toContain('Private fixture diagnostic')
      ending = 6
      await expect(repository.history('child')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    } finally {
      await transport.close()
    }
  })

  it('validates the complete projection batch before exposing a member and keeps private Team values Host-owned', () => {
    const adapter = new Adapter(transportOptions(globalThis.fetch), MASTER_FCC0AD_COMMIT)
    expect(adapter.project({ conversationContinuation: 4, agentTeam: masterTeam })).toEqual({
      conversationContinuation: 4,
    })
    expect(
      adapter.event({ type: 'session.projection', sessionId: 'root', key: 'agentTeam', value: masterTeam }),
    ).toEqual({ type: 'session.system', sessionId: 'root' })
    expect(() =>
      adapter.normalize({
        type: 'projection',
        sessionId: 'root',
        seq: 5,
        changes: [
          { key: 'conversationContinuation', val: 4 },
          { key: 'agentTeam', val: { enabled: true, tasks: 'invalid' } },
        ],
      }),
    ).toThrow('malformed development-contract response')
    expect(() => adapter.project({ conversationContinuation: -1 })).toThrow()
    expect(() =>
      adapter.normalize({
        type: 'projection',
        sessionId: 'root',
        seq: 5,
        changes: [{ key: 'conversationContinuation', val: 6 }],
      }),
    ).toThrow('beyond its projection cursor')
    expect(() =>
      adapter.normalize({
        type: 'baseline',
        value: {
          projections: {
            root: { asOfSeq: 5, values: { conversationContinuation: 6 } },
          },
        },
      }),
    ).toThrow('beyond its projection cursor')
    expect(
      adapter.normalize({
        type: 'baseline',
        value: {
          projections: {
            root: { asOfSeq: 5, values: { conversationContinuation: 4 } },
          },
        },
      }),
    ).toBeDefined()
  })

  it('publishes MCP status changes as catalogue hints with diagnostics kept on the Host client', () => {
    const adapter = new Adapter(transportOptions(globalThis.fetch), MASTER_FCC0AD_COMMIT)
    expect(
      adapter.event({
        type: 'remote.event',
        name: 'mcp-manager/status',
        args: [
          'fixture-server',
          { state: 'failed', reason: 'load', lastError: 'Private fixture diagnostic' },
        ],
      }),
    ).toEqual({ type: 'remote.event', name: 'mcp-manager/status', args: ['fixture-server'] })
  })

  it('maps inherited timed-question projections exactly once when extending subscribed baselines', () => {
    const adapter = new Adapter(transportOptions(globalThis.fetch), MASTER_FCC0AD_COMMIT)
    const userQuestions = {
      active: [
        {
          callId: 'question-call',
          state: 'open',
          questions: [
            {
              id: 'question',
              question: 'Continue?',
              detail: 'Fixture detail',
              header: 'Fixture',
              options: [{ label: 'Yes', description: 'Continue' }],
              multiSelect: false,
            },
          ],
        },
      ],
      settled: [],
    }
    expect(
      adapter.event({
        type: 'session.subscribed',
        sessionId: 'root',
        lastSequence: 5,
        projection: { asOfSequence: 5, values: { conversationContinuation: null, userQuestions } },
      }),
    ).toMatchObject({
      projection: { values: { userQuestions: { active: [{ questions: [{ prompt: 'Continue?' }] }] } } },
    })
  })

  it('projects names, rejects duplicate sibling names atomically, and permits follow-up with a cold parent', async () => {
    let catalog: unknown[] = [masterNamedChild]
    const requests: { method: string; payload: { args: Record<string, unknown> } }[] = []
    const adapter = new Adapter(
      transportOptions((_input, init) => {
        const request = JSON.parse(bodyText(init)) as (typeof requests)[number]
        requests.push(request)
        const sessionId = (request.payload.args.request as { sessionId?: string } | undefined)?.sessionId
        const reply =
          request.method === 'session/list'
            ? { items: [] }
            : request.method === 'session/projections'
              ? {
                  kind: 'sequenced',
                  asOfSeq: 5,
                  values: { subagentCatalog: sessionId === 'root' ? catalog : [] },
                }
              : request.method === 'subagents/prompt'
                ? { messageId: 'accepted-child-input' }
                : { accepted: true }
        return Promise.resolve(wrappedResponse(init, reply))
      }),
      MASTER_FCC0AD_COMMIT,
    )
    const transport = adapter.createTransport(endpoint)
    const repository = new MasterFcc0adSubagentRepository(transport, { subagentPromptDelivery: true })
    try {
      expect(await repository.list('root')).toMatchObject({
        parentAvailable: true,
        entries: [{ id: 'child', name: 'reviewer', label: 'Review the fixture' }],
      })
      catalog = [masterNamedChild, { ...masterNamedChild, id: 'other' }]
      await expect(repository.list('root')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
      expect(repository.parentOf('other')).toBeUndefined()
      expect(repository.parentOf('child')).toBe('root')
      await repository.send('child', 'Follow up')
      expect(requests.at(-1)).toMatchObject({
        method: 'subagents/prompt',
        payload: {
          args: {
            request: {
              childSessionId: 'child',
              delivery: 'queue',
              requestId: expect.any(String),
            },
          },
        },
      })
      const prompt = requests.at(-1)!.payload.args.request as Record<string, unknown>
      expect(prompt).not.toHaveProperty('parentSessionId')
      expect(prompt).not.toHaveProperty('mode')
    } finally {
      await transport.close()
    }
  })

  it('interrupts a Host-authorised child directly, including without a previously read catalog', async () => {
    const requests: unknown[] = []
    const adapter = new Adapter(
      transportOptions((_input, init) => {
        requests.push(JSON.parse(bodyText(init)))
        return Promise.resolve(wrappedResponse(init, { accepted: true }))
      }),
      MASTER_FCC0AD_COMMIT,
    )
    const transport = adapter.createTransport(endpoint)
    try {
      await new MasterFcc0adSubagentRepository(transport, {}).interrupt('child')
      await callRpc(transport, 'subagent.interrupt', {
        childSessionId: 'child',
        parentSessionId: 'root',
        mode: 'continuable',
      })
      expect(requests).toMatchObject([
        { method: 'subagents/interruptByUser', payload: { args: { childSessionId: 'child' } } },
        { method: 'subagents/interruptByUser', payload: { args: { childSessionId: 'child' } } },
      ])
      expect(
        requests.every(
          (request) => Object.keys((request as { payload: { args: object } }).payload.args).length === 1,
        ),
      ).toBe(true)
    } finally {
      await transport.close()
    }
  })
})
