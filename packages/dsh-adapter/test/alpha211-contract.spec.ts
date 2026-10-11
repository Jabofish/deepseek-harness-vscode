import { describe, expect, it } from 'vitest'
import type { BackendEndpoint } from '@dsh-vscode/domain'

import { VersionedBackendFactory } from '../src/backend-factory.js'
import type { DshTransport } from '../src/contracts.js'
import { VersionedBackendProbe } from '../src/probe.js'
import { Alpha211VersionAdapter } from '../src/versions/alpha211/adapter.js'
import { Alpha211ScheduleRepository } from '../src/versions/alpha211/schedule-repository.js'
import { Alpha211AccountLifecycleRepository } from '../src/versions/alpha211/account-repository.js'
import { Alpha211PluginBundleRepository } from '../src/versions/alpha211/plugin-manager-repository.js'
import { Alpha211SubagentRepository } from '../src/versions/alpha211/subagent-repository.js'
import { alpha211SessionProfile } from '../src/versions/alpha211/session-wire.js'
import { validAlpha171SessionSnapshot } from '../src/versions/alpha171/session-wire.js'
import { expandHistoryRecords } from '../src/versions/alpha/session-wire.js'
import { normalizeEnvelope } from '../src/stream-envelopes.js'
import { Rc202VersionAdapter } from '../src/versions/rc202/adapter.js'
import { Rc202UserQuestionRepository } from '../src/versions/rc202/user-question-repository.js'
import { candidate, transportOptions } from './support/contract-harness.js'
import { ProbeFixtureTransport } from './support/probe-fixture.js'

/** dsh-v0.2.1-alpha.1 / 5badb15009ae1756c3afe0ae0cef1faafc290ccc:
 * Session/Workspace probe types remain the rc202 contracts, independently audited
 * at packages/api/{session,workspace}-controller/src/{types.ts,index.ts}.
 */
const version = '0.2.1-alpha.1'
const options = transportOptions(globalThis.fetch)

class FixtureAdapter extends Alpha211VersionAdapter {
  public constructor(private readonly fixture: DshTransport) {
    super(options)
  }

  public override createTransport(_endpoint: BackendEndpoint): DshTransport {
    return this.fixture
  }
}

describe('DSH 0.2.1-alpha.1 exact adapter', () => {
  it('restores catalog v1 unknown facts and discovers children through the original projection baseline', async () => {
    const records = [
      {
        type: 'event',
        event: {
          type: 'subagent/catalog',
          seq: 0,
          time: 1,
          data: {
            version: 1,
            childId: 'unknown-1',
            childCreatedAt: 1,
            mode: 'unknown',
          },
        },
      },
    ]
    const snapshot = {
      type: 'snapshot',
      header: { version: 4, id: 's1', createdAt: 1, isSeeded: false },
      cursor: 0,
      records,
      hasMore: false,
      projections: { asOfSeq: 0, values: {} },
    }
    expect(validAlpha171SessionSnapshot(snapshot, alpha211SessionProfile)).toBe(true)
    const [event] = expandHistoryRecords(records, 's1', 'v4', false, alpha211SessionProfile)
    expect(normalizeEnvelope({ type: 'session/event', sessionId: 's1', event })).toMatchObject({
      type: 'subagent.catalog.updated',
      entry: { id: 'unknown-1', mode: 'unknown' },
    })
    const methods: string[] = []
    const source: DshTransport = {
      request: <T>(method: string) => {
        methods.push(method)
        return Promise.resolve({
          result: { ok: true, value: { items: [{ sessionId: 's1', agentAvailable: true, running: false }] } },
        } as T)
      },
      remoteRequest: <T>(method: string) => {
        methods.push(method)
        return Promise.resolve({
          ok: true,
          value: {
            asOfSeq: 0,
            values: { subagentCatalog: [{ id: 'unknown-1', createdAt: 1, mode: 'unknown' }] },
          },
        } as T)
      },
      openEventStream: async function* () {
        /* no fixture stream */
      },
      close: () => Promise.resolve(),
    }
    expect(await new Alpha211SubagentRepository(source).list('s1')).toMatchObject({
      parentAvailable: true,
      entries: [{ kind: 'diagnostic', id: 'unknown-1', reason: 'unsupported' }],
    })
    expect(methods).toEqual(['session/projections', 'session.list'])
  })
  it('selects the new identity and assembles version-local ports plus retained timed questions', async () => {
    const fixture = new ProbeFixtureTransport()
    const adapters = [new FixtureAdapter(fixture), new Rc202VersionAdapter(options)]
    const connected = await new VersionedBackendProbe(adapters).probe(candidate(version))
    expect(connected?.capabilities).toMatchObject({
      dshVersion: version,
      protocolVersion: 'alpha211',
      adapterId: `dsh-${version}`,
      compatibilityMode: 'exact',
    })
    expect(fixture.methods).toEqual(['session.list', 'workspace.list'])
    expect(fixture.closeCalls).toBe(1)
    if (connected === undefined) throw new Error('exact alpha211 probe declined its fixture')
    const backend = await new VersionedBackendFactory(adapters).connect(connected)
    try {
      expect(backend.schedules).toBeInstanceOf(Alpha211ScheduleRepository)
      expect(backend.account).toBeInstanceOf(Alpha211AccountLifecycleRepository)
      expect(backend.pluginBundles).toBeInstanceOf(Alpha211PluginBundleRepository)
      expect(backend.subagents).toBeInstanceOf(Alpha211SubagentRepository)
      expect(backend.userQuestions).toBeInstanceOf(Rc202UserQuestionRepository)
    } finally {
      await backend.close()
    }
  })

  it.each(['malformed', 'business-error', 'protocol-error', 'timeout'] as const)(
    'declines %s and closes the probe transport',
    async (mode) => {
      const fixture = new ProbeFixtureTransport(mode)
      await expect(new FixtureAdapter(fixture).probe(candidate(version))).resolves.toBeUndefined()
      expect(fixture.closeCalls).toBe(1)
    },
  )

  it('propagates cancellation and releases the owned probe', async () => {
    const fixture = new ProbeFixtureTransport()
    const controller = new AbortController()
    controller.abort()
    await expect(
      new FixtureAdapter(fixture).probe(candidate(version), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.closeCalls).toBe(1)
  })

  it('declines adjacent, malformed and unknown identities without touching the transport', async () => {
    const fixture = new ProbeFixtureTransport()
    const adapter = new FixtureAdapter(fixture)
    for (const label of ['0.2.0-rc.2', '0.2.1-alpha.2', `${version}+unverified`, `DSH ${version}`]) {
      await expect(adapter.probe(candidate(label))).resolves.toBeUndefined()
    }
    await expect(adapter.probeCompatibility()).resolves.toBeUndefined()
    expect(adapter.fallback).toBe(false)
    expect(fixture.methods).toEqual([])
    expect(fixture.closeCalls).toBe(0)
  })
})
