import { describe, expect, it } from 'vitest'

import type { BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import { VersionedBackendFactory } from '../src/backend-factory.js'
import type { DshTransport } from '../src/contracts.js'
import { VersionedBackendProbe } from '../src/probe.js'
import { Rc201VersionAdapter } from '../src/versions/rc201/adapter.js'
import { Rc201ScheduleRepository } from '../src/versions/rc201/schedule-repository.js'
import { Rc172SessionRepository } from '../src/versions/rc172/session-repository.js'
import { Rc172VersionAdapter } from '../src/versions/rc172/adapter.js'

/**
 * DSH tag dsh-v0.2.0-rc.1, commit 4878cdabd87d4041bdaff61d04c966883b9fd07a:
 * packages/api/session-controller/src/client/sessions/remotes.ts Session list,
 * packages/api/workspace-controller/src/client/service.ts Workspace list, and
 * packages/api/gateway/src/index.ts Remote result/error envelopes.
 */
const RC201_VERSION = '0.2.0-rc.1'

class ProbeFixtureTransport implements DshTransport {
  public readonly methods: string[] = []
  public closeCalls = 0

  public constructor(
    private readonly responseMode:
      'valid' | 'malformed' | 'business-error' | 'protocol-error' | 'timeout' = 'valid',
  ) {}

  public request<TResponse>(method: string, _params: unknown, signal?: AbortSignal): Promise<TResponse> {
    this.methods.push(method)
    if (signal?.aborted) return Promise.reject<TResponse>(new DOMException('Cancelled', 'AbortError'))
    if (this.responseMode === 'timeout')
      return Promise.reject<TResponse>(new DOMException('Timed out', 'TimeoutError'))
    if (this.responseMode === 'protocol-error') return Promise.resolve(undefined as TResponse)
    if (this.responseMode === 'business-error')
      return Promise.resolve({
        rpcId: 'fixture',
        result: { ok: false, error: { code: 'session-not-found', message: 'No session' } },
      } as TResponse)
    const value =
      method === 'session.list'
        ? this.responseMode === 'malformed'
          ? { items: 'not-an-array' }
          : { items: [{ sessionId: 's-1', agentAvailable: true }] }
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
    this.closeCalls += 1
    return Promise.resolve()
  }
}

class Rc201ProbeFixtureAdapter extends Rc201VersionAdapter {
  public constructor(
    options: ConstructorParameters<typeof Rc201VersionAdapter>[0],
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

describe('DSH 0.2.0-rc.1 exact adapter contract', () => {
  it('selects the released adapter and constructs its RC2-derived repositories', async () => {
    const fixture = new ProbeFixtureTransport()
    const rc201 = new Rc201ProbeFixtureAdapter(options, fixture)
    const rc172 = new Rc172VersionAdapter(options)
    const adapters = [rc201, rc172]
    const connected = await new VersionedBackendProbe(adapters).probe(candidate(RC201_VERSION))

    expect(connected?.capabilities).toMatchObject({
      protocolVersion: 'rc201',
      dshVersion: RC201_VERSION,
      adapterId: `dsh-${RC201_VERSION}`,
      compatibilityMode: 'exact',
    })
    expect(fixture.methods).toEqual(['session.list', 'workspace.list'])
    expect(fixture.closeCalls).toBe(1)

    if (connected === undefined) throw new Error('the exact rc201 probe declined its fixture')
    const backend = await new VersionedBackendFactory(adapters).connect(connected)
    expect(backend.sessions).toBeInstanceOf(Rc172SessionRepository)
    expect(backend.schedules).toBeInstanceOf(Rc201ScheduleRepository)
    expect(backend.pluginBundles).toBeDefined()
    await backend.close()
  })

  it.each(['malformed', 'business-error', 'protocol-error', 'timeout'] as const)(
    'rejects a %s probe response and releases its transport',
    async (responseMode) => {
      const fixture = new ProbeFixtureTransport(responseMode)
      const adapter = new Rc201ProbeFixtureAdapter(options, fixture)
      await expect(adapter.probe(candidate(RC201_VERSION))).resolves.toBeUndefined()
      expect(fixture.closeCalls).toBe(1)
    },
  )

  it('propagates cancellation and releases its transport', async () => {
    const fixture = new ProbeFixtureTransport()
    const adapter = new Rc201ProbeFixtureAdapter(options, fixture)
    const controller = new AbortController()
    controller.abort()
    await expect(adapter.probe(candidate(RC201_VERSION), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fixture.closeCalls).toBe(1)
  })

  it('does not reuse the exact RC adapter for an adjacent or old master version', async () => {
    const adapter = new Rc201VersionAdapter(options)
    await expect(new VersionedBackendProbe([adapter]).probe(candidate('0.2.0-rc.2'))).resolves.toBeUndefined()
    await expect(
      adapter.probe(candidate('0.1.7-master.21638c56315ae6a2b552d6091945d3144c9af32e')),
    ).resolves.toBeUndefined()
  })
})
