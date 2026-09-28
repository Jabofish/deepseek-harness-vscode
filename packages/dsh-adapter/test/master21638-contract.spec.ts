import { describe, expect, it } from 'vitest'

import type { BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import { VersionedBackendFactory } from '../src/backend-factory.js'
import type { DshTransport } from '../src/contracts.js'
import { VersionedBackendProbe } from '../src/probe.js'
import { Master21638VersionAdapter } from '../src/versions/master21638/adapter.js'
import { Master21638ScheduleRepository } from '../src/versions/master21638/schedule-repository.js'
import { Rc172SessionRepository } from '../src/versions/rc172/session-repository.js'
import { Rc172VersionAdapter } from '../src/versions/rc172/adapter.js'

/** Temporary exact identity bound to upstream master commit 21638c56315ae6a2b552d6091945d3144c9af32e. */
const MASTER_VERSION = '0.1.7-master.21638c56315ae6a2b552d6091945d3144c9af32e'

class ProbeFixtureTransport implements DshTransport {
  public readonly methods: string[] = []

  public request<TResponse>(method: string): Promise<TResponse> {
    this.methods.push(method)
    const value =
      method === 'session.list'
        ? { items: [{ sessionId: 's-1', agentAvailable: true }] }
        : method === 'workspace.list'
          ? { items: [], archivedSessionIds: [], pinnedSessionIds: [] }
          : undefined
    return Promise.resolve({ rpcId: 'fixture', result: { ok: true, value } } as TResponse)
  }

  public remoteRequest<TResponse>(): Promise<TResponse> {
    return Promise.reject<TResponse>(new Error('the exact probe fixture issues no Remote calls'))
  }

  public async *openEventStream(): AsyncIterable<unknown> {
    /* This probe fixture does not subscribe to the runtime event stream. */
  }

  public close(): Promise<void> {
    return Promise.resolve()
  }
}

class MasterProbeFixtureAdapter extends Master21638VersionAdapter {
  public constructor(
    options: ConstructorParameters<typeof Master21638VersionAdapter>[0],
    private readonly fixture: DshTransport,
  ) {
    super(options)
  }

  public override createTransport(_endpoint: BackendEndpoint): DshTransport {
    return this.fixture
  }
}

const endpoint: BackendEndpoint = {
  host: '127.0.0.1',
  port: 4567,
  baseUrl: 'http://127.0.0.1:4567',
}

const options = {
  requestTimeoutMs: 1_000,
  retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
  fetch: globalThis.fetch,
}

function candidate(runtimeVersion: string): BackendCandidate {
  return { endpoint, source: 'configured', runtimeVersion, confidence: 1 }
}

describe('temporary upstream master adapter identity', () => {
  it('selects the commit-bound exact adapter and constructs its RC2-derived repositories', async () => {
    const fixture = new ProbeFixtureTransport()
    const master = new MasterProbeFixtureAdapter(options, fixture)
    const rc172 = new Rc172VersionAdapter(options)
    const adapters = [master, rc172]
    const connected = await new VersionedBackendProbe(adapters).probe(candidate(MASTER_VERSION))

    expect(connected?.capabilities).toMatchObject({
      protocolVersion: 'rc172',
      dshVersion: MASTER_VERSION,
      adapterId: `dsh-${MASTER_VERSION}`,
      compatibilityMode: 'exact',
    })
    expect(fixture.methods).toEqual(['session.list', 'workspace.list'])

    if (connected === undefined) throw new Error('the exact master probe declined its fixture')
    const backend = await new VersionedBackendFactory(adapters).connect(connected)
    expect(backend.sessions).toBeInstanceOf(Rc172SessionRepository)
    expect(backend.schedules).toBeInstanceOf(Master21638ScheduleRepository)
    expect(backend.pluginBundles).toBeDefined()
    await backend.close()
  })

  it('does not reuse the exact master adapter for another unknown master label', async () => {
    const adapter = new Master21638VersionAdapter(options)
    await expect(
      new VersionedBackendProbe([adapter]).probe(
        candidate('0.1.7-master.0000000000000000000000000000000000000000'),
      ),
    ).resolves.toBeUndefined()
  })
})
