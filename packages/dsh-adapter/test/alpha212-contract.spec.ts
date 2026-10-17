import { describe, expect, it, vi } from 'vitest'
import type { BackendEndpoint, BackendEvent, SessionDetail, SessionSummary } from '@dsh-vscode/domain'

import { VersionedBackendProbe } from '../src/probe.js'
import type { DshTransport } from '../src/contracts.js'
import { Alpha212VersionAdapter } from '../src/versions/alpha212/adapter.js'
import { Alpha211VersionAdapter } from '../src/versions/alpha211/adapter.js'
import { Alpha212SessionRepository } from '../src/versions/alpha212/session-repository.js'
import { Alpha212PluginBundleRepository } from '../src/versions/alpha212/plugin-manager-repository.js'
import { Alpha212SubagentRepository } from '../src/versions/alpha212/subagent-repository.js'
import { alpha212SessionProfile } from '../src/versions/alpha212/session-wire.js'
import {
  validAlpha171SessionEvent,
  validAlpha171SessionSnapshot,
} from '../src/versions/alpha171/session-wire.js'
import { expandHistoryRecords, normalizeAlphaEvent } from '../src/versions/alpha/session-wire.js'
import { normalizeEnvelope } from '../src/stream-envelopes.js'
import { Rc6SubagentRepository } from '../src/repositories/subagent-repository.js'
import { Rc6WorkspaceRepository } from '../src/repositories/workspace-repository.js'
import { SubagentAddressRegistry } from '../src/repositories/shared/subagent-addresses.js'
import { candidate, transportOptions } from './support/contract-harness.js'
import { ProbeFixtureTransport } from './support/probe-fixture.js'

// Exact d743267388641bc76f17c45ce8b4c231aed1d32c: working-directory/src/index.ts,
// subagent/src/catalog.ts, session-controller/src/types.ts, plugin-manager/src/types.ts.
const options = transportOptions(globalThis.fetch)
const directory = {
  type: 'working-directory/change',
  seq: 0,
  time: 1,
  data: { cwd: '/fixture/project/next' },
}
const external = {
  type: 'subagent/catalog',
  seq: 1,
  time: 2,
  data: {
    version: 2,
    childId: 'external-1',
    childCreatedAt: 1,
    mode: 'external',
    label: 'Worker',
  },
}

class FixtureAdapter extends Alpha212VersionAdapter {
  public constructor(private readonly fixture: DshTransport) {
    super(options)
  }
  public override createTransport(_endpoint: BackendEndpoint): DshTransport {
    return this.fixture
  }
}

function transport(
  request: (method: string, args: unknown) => unknown = () => undefined,
  remote: (method: string, args: Readonly<Record<string, unknown>>) => unknown = () => undefined,
): DshTransport {
  return {
    request: <T>(method: string, args: unknown) =>
      Promise.resolve({ result: { ok: true, value: request(method, args) } } as T),
    remoteRequest: <T>(method: string, args: Readonly<Record<string, unknown>>) =>
      Promise.resolve(remote(method, args) as T),
    openEventStream: async function* () {
      /* no fixture stream */
    },
    close: () => Promise.resolve(),
  }
}

describe('alpha212 exact V4 delta', () => {
  it('selects alpha.2 independently, retains alpha.1 and closes failed or cancelled probes', async () => {
    for (const mode of ['valid', 'malformed', 'business-error', 'protocol-error', 'timeout'] as const) {
      const fixture = new ProbeFixtureTransport(mode)
      const adapter = new FixtureAdapter(fixture)
      const backend = await new VersionedBackendProbe([adapter, new Alpha211VersionAdapter(options)]).probe(
        candidate('0.2.1-alpha.2'),
      )
      expect(backend?.capabilities.adapterId).toBe(mode === 'valid' ? 'dsh-0.2.1-alpha.2' : undefined)
      expect(fixture.closeCalls).toBe(1)
    }
    const fixture = new ProbeFixtureTransport()
    const adapter = new FixtureAdapter(fixture)
    for (const version of ['0.2.1-alpha.1', '0.2.1-alpha.3', '0.2.1-alpha.2+unverified'])
      expect(await adapter.probe(candidate(version))).toBeUndefined()
    expect(fixture.methods).toEqual([])
    expect(adapter.fallback).toBe(false)
    const abort = new AbortController()
    abort.abort()
    await expect(adapter.probe(candidate('0.2.1-alpha.2'), abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fixture.closeCalls).toBe(1)
  })

  it('admits new required facts in full snapshots, history and live normalization without widening old admission', () => {
    const records = [directory, external].map((event) => ({ type: 'event', event }))
    const snapshot = {
      type: 'snapshot',
      header: { version: 4, id: 's1', createdAt: 1, isSeeded: false },
      cursor: 1,
      records,
      hasMore: false,
      projections: { asOfSeq: 1, values: { workingDirectory: directory.data.cwd } },
    }
    expect(validAlpha171SessionSnapshot(snapshot, alpha212SessionProfile)).toBe(true)
    expect(validAlpha171SessionSnapshot(snapshot)).toBe(false)
    const events = expandHistoryRecords(records, 's1', 'v4', false, alpha212SessionProfile)
    const mapped = events.map((event) => normalizeEnvelope({ type: 'session/event', sessionId: 's1', event }))
    expect(mapped[0]).toMatchObject({
      type: 'session.projection',
      key: 'workingDirectory',
      value: directory.data.cwd,
      sequence: 0,
    })
    expect(mapped[1]).toMatchObject({
      type: 'subagent.catalog.updated',
      entry: { mode: 'external' },
      sequence: 1,
    })
    expect(normalizeAlphaEvent(directory, 's1', 'v4', false, alpha212SessionProfile)).toEqual(events[0])
    expect(
      expandHistoryRecords([{ type: 'chunks', event: {} }], 's1', 'v4', false, alpha212SessionProfile),
    ).toEqual([])
  })

  it('rejects malformed directories, catalog versions, envelopes and sequence relationships', () => {
    for (const cwd of ['', 'relative', null, '/fixture\0secret'])
      expect(validAlpha171SessionEvent({ ...directory, data: { cwd } }, alpha212SessionProfile)).toBe(false)
    for (const data of [
      { ...external.data, version: 0 },
      { ...external.data, childCreatedAt: -1 },
      { ...external.data, extra: true },
    ])
      expect(validAlpha171SessionEvent({ ...external, data }, alpha212SessionProfile)).toBe(false)
    expect(validAlpha171SessionEvent({ ...directory, surfaceOp: 'append' }, alpha212SessionProfile)).toBe(
      false,
    )
    expect(validAlpha171SessionEvent({ ...directory, seq: -1 }, alpha212SessionProfile)).toBe(false)
    expect(
      validAlpha171SessionEvent(
        { type: 'plugin:fixture/change', seq: 2, time: 2, data: {}, ignorable: true },
        alpha212SessionProfile,
      ),
    ).toBe(true)
    expect(
      validAlpha171SessionEvent(
        { type: 'unknown/required', seq: 2, time: 2, data: {} },
        alpha212SessionProfile,
      ),
    ).toBe(false)
    for (const mode of ['one-shot', 'continuable']) {
      const event = { ...external, data: { ...external.data, version: 1, mode } }
      expect(validAlpha171SessionEvent(event, alpha212SessionProfile)).toBe(true)
      expect(
        normalizeEnvelope({
          type: 'session/event',
          sessionId: 's1',
          event: normalizeAlphaEvent(event, 's1', 'v4', false, alpha212SessionProfile),
        }),
      ).toMatchObject({ type: 'subagent.catalog.updated', entry: { mode } })
    }
    const unknown = { ...external, data: { ...external.data, version: 1, mode: 'unknown' } }
    expect(
      normalizeEnvelope({
        type: 'session/event',
        sessionId: 's1',
        event: normalizeAlphaEvent(unknown, 's1', 'v4', false, alpha212SessionProfile),
      }),
    ).toMatchObject({ type: 'subagent.catalog.updated', entry: { mode: 'unknown' } })
  })

  it('keeps external executions out of local history and prompt routing, including catalog replacement', async () => {
    const addresses = new SubagentAddressRegistry()
    addresses.replaceParent('s1', [{ id: 'external-1', mode: 'continuable' }])
    const catalog = {
      entries: [
        {
          kind: 'child',
          id: 'external-1',
          mode: 'external',
          label: 'Worker',
          activity: 'inactive',
          hasChildren: false,
        },
      ],
      parentAvailable: true,
    }
    const source = transport(() => catalog)
    const repository = new Rc6SubagentRepository(source, { externalCatalog: true, addresses })
    expect((await repository.list('s1')).entries[0]).toMatchObject({ mode: 'external' })
    expect(addresses.resolve('external-1')).toBeUndefined()
    await expect(repository.history('external-1')).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    await expect(repository.send('external-1', 'fixture')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    await expect(repository.interrupt('external-1')).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    await expect(new Rc6SubagentRepository(source).list('s1')).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    catalog.entries[0]!.hasChildren = true
    await expect(repository.list('s1')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(addresses.resolve('external-1')).toBeUndefined()
  })

  it('reads sequenced child projections and rejects migration hints without issuing the retired list Remote', async () => {
    let projection: unknown = {
      kind: 'sequenced',
      asOfSeq: 2,
      values: {
        subagentCatalog: [
          { id: 'external-1', createdAt: 1, mode: 'external' },
          { id: 'local-1', createdAt: 1, mode: 'continuable', label: 'Local' },
          { id: 'unknown-1', createdAt: 1, mode: 'unknown' },
        ],
      },
    }
    const remote = vi.fn((_method: string, args: Readonly<Record<string, unknown>>) => ({
      ok: true,
      value:
        (args.request as { sessionId: string }).sessionId === 's1'
          ? projection
          : {
              kind: 'sequenced',
              asOfSeq: 0,
              values: { subagentCatalog: [{ id: 'nested-1', createdAt: 1, mode: 'one-shot' }] },
            },
    }))
    const source = transport(
      () => ({
        items: [
          { sessionId: 's1', agentAvailable: true, running: false },
          { sessionId: 'local-1', agentAvailable: true, running: true },
        ],
      }),
      remote,
    )
    const addresses = new SubagentAddressRegistry()
    const repository = new Alpha212SubagentRepository(source, { addresses })
    const catalog = await repository.list('s1')
    expect(catalog).toMatchObject({
      parentAvailable: true,
      entries: [
        { mode: 'external', hasChildren: false, activity: 'inactive' },
        { mode: 'continuable', hasChildren: true, activity: 'running' },
        { kind: 'diagnostic', reason: 'unsupported' },
      ],
    })
    expect(remote.mock.calls.map(([method]) => method)).toEqual([
      'session/projections',
      'session/projections',
    ])
    expect(addresses.resolve('local-1')).toEqual({ parentSessionId: 's1', mode: 'continuable' })
    expect(addresses.resolve('external-1')).toBeUndefined()
    for (const value of [
      null,
      { kind: 'sequenced', asOfSeq: -2, values: {} },
      { kind: 'migration-required', values: { subagentCatalog: [{ id: 'untrusted', mode: 'continuable' }] } },
    ]) {
      projection = value
      await expect(repository.list('s1')).rejects.toMatchObject({
        code:
          value === null
            ? 'CAPABILITY_UNAVAILABLE'
            : value.kind === 'migration-required'
              ? 'INVALID_CONFIGURATION'
              : 'PROTOCOL_ERROR',
      })
      expect(addresses.resolve('untrusted')).toBeUndefined()
    }
  })

  it('retains operation-time navigation and nested PTC meta only for successful results', () => {
    const result = {
      type: 'tool/result',
      seq: 3,
      time: 4,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        callId: 'read-1',
        toolName: 'read',
        meta: { path: '/fixture/project/next/file.ts' },
        message: {
          id: 'result-1',
          role: 'tool',
          source: { kind: 'tool', callId: 'read-1' },
          toolCallId: 'read-1',
          content: [{ type: 'text', text: 'Fixture' }],
        },
      },
    }
    expect(validAlpha171SessionEvent(result, alpha212SessionProfile)).toBe(true)
    const map = (event: unknown): BackendEvent | undefined =>
      normalizeEnvelope({
        type: 'session/event',
        sessionId: 's1',
        event: normalizeAlphaEvent(event, 's1', 'v4', false, alpha212SessionProfile),
      })
    expect(map(result)).toMatchObject({
      type: 'tool.updated',
      tool: { locations: [{ path: '/fixture/project/next/file.ts' }] },
    })
    const ptc = {
      type: 'tool/ptc-dispatch',
      seq: 4,
      time: 5,
      data: {
        callId: 'parent-1',
        subCallId: 'nested-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'Fixture' }],
        meta: result.data.meta,
      },
    }
    expect(map(ptc)).toMatchObject({
      type: 'tool.updated',
      tool: { locations: [{ path: '/fixture/project/next/file.ts' }] },
    })
    expect(
      map({ ...result, data: { ...result.data, message: { ...result.data.message, isError: true } } }),
    ).not.toHaveProperty('tool.locations')
    expect(() =>
      map({
        ...result,
        data: {
          ...result.data,
          message: {
            ...result.data.message,
            content: [
              {
                type: 'tool-result',
                toolCallId: 'read-1',
                isError: true,
                content: [{ type: 'text', text: 'Refused' }],
              },
            ],
          },
        },
      }),
    ).toThrow('Malformed alpha.1 tool/result V4 message')
  })
})

describe('alpha212 Session migration boundary', () => {
  class SessionFixture extends Alpha212SessionRepository {
    public summary(value: unknown): SessionSummary {
      return this.mapSessionSummary(value)
    }
    public override get(id: string): Promise<SessionDetail> {
      return Promise.resolve({
        id,
        workspaceId: '',
        title: 'Fork',
        blank: true,
        status: 'idle',
        createdAt: '',
        updatedAt: '',
        configuration: {
          preset: '',
          toolMode: 'native',
          permissionPreset: '',
          planMode: false,
          model: { providerId: '', modelId: '' },
        },
      })
    }
  }
  it('preserves format status and forks without implicit migration; handles refusal and malformed receipts', async () => {
    let result: unknown = { ok: true, value: { sessionId: 'fork-1' } }
    const remote = vi.fn(() => result)
    const source = transport(undefined, remote)
    const repository = new SessionFixture(source, new Rc6WorkspaceRepository(source), undefined, {})
    expect(repository.summary({ sessionId: 's1', formatStatus: 'migration-required' })).toMatchObject({
      formatStatus: 'migration-required',
    })
    expect(() => repository.summary({ sessionId: 's1', formatStatus: 'future' })).toThrow()
    expect(await repository.fork('s1', 4)).toMatchObject({ id: 'fork-1' })
    expect(remote).toHaveBeenCalledWith('session/fork', {
      request: { sessionId: 's1', atSeq: 4, allowMigration: false },
    })
    result = { ok: false, error: { code: 'session/migration-required' } }
    await expect(repository.fork('s1')).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      message: 'Open the original session to migrate it before forking.',
    })
    result = { ok: true, value: {} }
    await expect(repository.fork('s1')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
})

describe('alpha212 official bundles', () => {
  it('validates the new inventory and uses exact installation while retaining actual version receipts', async () => {
    const bundle = {
      name: '@fixture/official',
      official: true,
      availability: 'missing',
      installTarget: { spec: '/fixture/development/bundle', version: '0.2.1-alpha.2' },
      enabled: false,
      installed: false,
      optional: false,
      removable: false,
      rows: [],
      overrides: [],
    }
    const remote = vi.fn((method: string) => ({
      ok: true,
      value: method.endsWith('listBundles')
        ? [bundle]
        : {
            target: 'fixture-spec',
            enabled: true,
            changed: true,
            application: 'applied',
            bundle: bundle.name,
            version: '0.2.1-alpha.2',
            stage: 'install',
          },
    }))
    const repository = new Alpha212PluginBundleRepository(transport(undefined, remote))
    expect((await repository.listBundles())[0]).toMatchObject({
      official: true,
      availability: 'missing',
      installTarget: bundle.installTarget,
    })
    await expect(
      repository.installBundle('fixture-spec', { requestId: 'install-1', saveExact: true }),
    ).resolves.toMatchObject({ version: '0.2.1-alpha.2' })
    expect(remote).toHaveBeenLastCalledWith('pluginManager/installBundle', {
      spec: 'fixture-spec',
      options: { requestId: 'install-1', enabled: true, saveExact: true },
    })
    bundle.availability = 'unverified'
    await expect(repository.listBundles()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
})
