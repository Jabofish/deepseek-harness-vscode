import { describe, expect, it } from 'vitest'
import { Rc222VersionAdapter } from '../src/versions/rc222/adapter.js'
import { rc222SessionProfile } from '../src/versions/rc222/session-wire.js'
import { rc222CatalogFactSchema } from '../src/versions/rc222/contracts.js'
import { alpha222SessionProfile } from '../src/versions/alpha222/session-wire.js'
import {
  validAlpha171SessionEvent,
  validAlpha171SessionSnapshot,
} from '../src/versions/alpha171/session-wire.js'
import type { BackendEvent, SessionProjectionValues } from '@dsh-vscode/domain'
import { Rc222SubagentRepository } from '../src/versions/rc222/subagent-repository.js'
import { ProbeFixtureTransport } from './support/probe-fixture.js'
import { bodyText, endpoint, transportOptions, wrappedResponse } from './support/contract-harness.js'
import { callRpc } from '../src/versions/rc6/rpc.js'
import {
  rc222NamedCatalogFact,
  rc222NamedChild,
  rc222CatalogSnapshot,
  rc222Team,
} from './fixtures/rc222-session-contract.js'

class Adapter extends Rc222VersionAdapter {
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

describe('released rc222 Session contracts', () => {
  it('accepts rc.2 catalog v3 and team/mode while keeping earlier profiles strict', () => {
    const catalog = { type: 'subagent/catalog', seq: 4, time: 1_000, data: rc222NamedCatalogFact }
    expect(validAlpha171SessionEvent(catalog, rc222SessionProfile)).toBe(true)
    expect(validAlpha171SessionEvent(catalog, alpha222SessionProfile)).toBe(false)
    const mode = { type: 'team/mode', seq: 5, time: 1_000, data: { enabled: true } }
    expect(validAlpha171SessionEvent(mode, rc222SessionProfile)).toBe(true)
    expect(validAlpha171SessionEvent(mode, alpha222SessionProfile)).toBe(false)
    expect(rc222SessionProfile.normalizeEvent?.(catalog)).toMatchObject({
      type: 'subagent/catalog',
      data: { version: 0, mode: 'continuable' },
    })
    expect(rc222SessionProfile.normalizeEvent?.(mode)).toMatchObject({
      type: 'system/message',
      data: {},
    })
  })

  it.each(['lead', 'Upper', 'a/b', '', 'a'.repeat(33)])('rejects invalid catalog name %s', (name) => {
    expect(rc222CatalogFactSchema.safeParse({ ...rc222NamedCatalogFact, name }).success).toBe(false)
  })

  it('restores complete v3 catalog snapshots and rejects conflicting own names and child identities', () => {
    expect(validAlpha171SessionSnapshot(rc222CatalogSnapshot, rc222SessionProfile)).toBe(true)
    expect(validAlpha171SessionSnapshot(rc222CatalogSnapshot, alpha222SessionProfile)).toBe(false)
    for (const conflict of [{ name: 'reviewer' }, { childId: 'child' }]) {
      const records = rc222CatalogSnapshot.records.map((record) =>
        record.event.seq === 1
          ? { ...record, event: { ...record.event, data: { ...record.event.data, ...conflict } } }
          : record,
      )
      expect(validAlpha171SessionSnapshot({ ...rc222CatalogSnapshot, records }, rc222SessionProfile)).toBe(
        false,
      )
    }
    expect(rc222CatalogSnapshot.records[1]?.event.data).toMatchObject({ version: 3, name: 'writer' })
  })

  it('checks sibling-name uniqueness only within the current own suffix', () => {
    const inherited = { type: 'subagent/catalog', seq: 0, time: 1_000, data: rc222NamedCatalogFact }
    const marker = { type: 'session/end-seed', seq: 1, time: 1_001, data: { inherited: true } }
    const own = {
      type: 'subagent/catalog',
      seq: 2,
      time: 1_002,
      data: { ...rc222NamedCatalogFact, childId: 'own-child' },
    }
    const artifact = {
      header: { ...rc222CatalogSnapshot.header, isSeeded: true, parentSession: 'seed-parent' },
      inheritedEventCount: 1,
      events: [inherited, marker, own],
    }
    const known = new Set(['subagent/catalog', 'session/end-seed'])
    expect(() => rc222SessionProfile.restoreArtifact?.(artifact, known)).not.toThrow()
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
                    agentTeam: { ...rc222Team, failure: 'Private fixture diagnostic' },
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
            values: { subagentCatalog: sessionId === 'root' ? [rc222NamedChild] : [] },
          },
        } as TResponse)
      }
    }
    const transport = new HistoryTransport()
    const repository = new Rc222SubagentRepository(transport, {})
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
    const adapter = new Adapter(transportOptions(globalThis.fetch))
    expect(adapter.project({ conversationContinuation: 4, agentTeam: rc222Team })).toEqual({
      conversationContinuation: 4,
      todoList: null,
    })
    expect(
      adapter.event({ type: 'session.projection', sessionId: 'root', key: 'agentTeam', value: rc222Team }),
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
    ).toThrow('malformed rc222 contract response')
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
    const adapter = new Adapter(transportOptions(globalThis.fetch))
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
    const adapter = new Adapter(transportOptions(globalThis.fetch))
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
    let catalog: unknown[] = [rc222NamedChild]
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
    )
    const transport = adapter.createTransport(endpoint)
    const repository = new Rc222SubagentRepository(transport, { subagentPromptDelivery: true })
    try {
      expect(await repository.list('root')).toMatchObject({
        parentAvailable: true,
        entries: [{ id: 'child', name: 'reviewer', label: 'Review the fixture' }],
      })
      catalog = [rc222NamedChild, { ...rc222NamedChild, id: 'other' }]
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
            },
          },
        },
      })
      const prompt = requests.at(-1)!.payload.args.request as Record<string, unknown>
      expect(prompt.requestId).toEqual(expect.any(String))
      expect(prompt.requestId).not.toBe('')
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
    )
    const transport = adapter.createTransport(endpoint)
    try {
      await new Rc222SubagentRepository(transport, {}).interrupt('child')
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
