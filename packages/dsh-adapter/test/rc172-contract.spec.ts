import { describe, expect, it, vi } from 'vitest'

import { AppError, type BackendCandidate, type BackendEndpoint } from '@dsh-vscode/domain'

import { VersionedBackendFactory } from '../src/backend-factory.js'
import type { DshTransport } from '../src/contracts.js'
import { Rc6WorkspaceRepository } from '../src/repositories/workspace-repository.js'
import { unwrapRpcResultValue } from '../src/versions/rc6/rpc.js'
import { Alpha171PluginRepository } from '../src/versions/alpha171/plugin-repository.js'
import { Rc171VersionAdapter } from '../src/versions/rc171/adapter.js'
import { Rc172PresetRepository } from '../src/versions/rc172/preset-repository.js'
import { Rc172SessionRepository } from '../src/versions/rc172/session-repository.js'
import { Rc172ScheduleRepository } from '../src/versions/rc172/schedule-repository.js'
import { Rc172PluginBundleRepository } from '../src/versions/rc172/plugin-manager-repository.js'
import { Rc172VersionAdapter } from '../src/versions/rc172/adapter.js'
import { VersionedBackendProbe } from '../src/probe.js'

/**
 * Fixture authority: DSH tag `dsh-v0.1.7-rc.2`, commit
 * `477b4f420553e8a52c2fbccc464d7561b239c443`.
 */
class ProbeFixtureTransport implements DshTransport {
  public readonly methods: string[] = []
  public closeCalls = 0

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
    /* Probe fixtures do not subscribe to the runtime event stream. */
  }

  public close(): Promise<void> {
    this.closeCalls += 1
    return Promise.resolve()
  }
}

class Rc172ProbeFixtureAdapter extends Rc172VersionAdapter {
  public constructor(
    options: ConstructorParameters<typeof Rc172VersionAdapter>[0],
    private readonly fixture: DshTransport,
  ) {
    super(options)
  }

  public override createTransport(_endpoint: BackendEndpoint): DshTransport {
    return this.fixture
  }
}

class Rc171ProbeFixtureAdapter extends Rc171VersionAdapter {
  public constructor(
    options: ConstructorParameters<typeof Rc171VersionAdapter>[0],
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

const adapterOptions = {
  requestTimeoutMs: 1_000,
  retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
  fetch: globalThis.fetch,
}

function candidate(runtimeVersion: string): BackendCandidate {
  return { endpoint, source: 'configured', runtimeVersion, confidence: 1 }
}

describe('DSH 0.1.7-rc.2 exact adapter contract', () => {
  it('has a unique exact identity and retains rc.1 turn-window transport behavior', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.reject<Response>(new Error('an unsupported version must not make a request')),
    )
    const adapter = new Rc172VersionAdapter({ ...adapterOptions, fetch })

    expect(adapter).toMatchObject({
      id: 'dsh-0.1.7-rc.2',
      supportedVersion: '0.1.7-rc.2',
      protocolVersion: 'rc172',
      compatibilityPriority: 240,
      fallback: false,
    })
    expect(adapter).toBeInstanceOf(Rc171VersionAdapter)
    await expect(adapter.probeCompatibility()).resolves.toBeUndefined()
    await expect(adapter.probe(candidate('0.1.7-rc.1'))).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()

    const transport = adapter.createTransport(endpoint)
    expect(transport.sessionHistoryTurnWindow).toBe(true)
    await transport.close()
  })

  it('routes the exact probe and backend factory to rc.2 and its preset repository', async () => {
    const fixture = new ProbeFixtureTransport()
    const rc172 = new Rc172ProbeFixtureAdapter(adapterOptions, fixture)
    const rc171 = new Rc171VersionAdapter(adapterOptions)
    const connected = await new VersionedBackendProbe([rc172, rc171]).probe(candidate('0.1.7-rc.2'))

    expect(connected).toMatchObject({
      capabilities: {
        protocolVersion: 'rc172',
        dshVersion: '0.1.7-rc.2',
        adapterId: 'dsh-0.1.7-rc.2',
        sessionRestore: true,
        jobController: true,
      },
    })
    expect(fixture.methods).toEqual(['session.list', 'workspace.list'])
    expect(fixture.closeCalls).toBe(1)

    if (connected === undefined) throw new Error('the exact rc172 probe declined its fixture')
    const backend = await new VersionedBackendFactory([rc172, rc171]).connect(connected)
    expect(backend.plugins).toBeInstanceOf(Alpha171PluginRepository)
    expect(backend.sessions).toBeInstanceOf(Rc172SessionRepository)
    expect(backend.sessions.initializeDefaultModel).toBeTypeOf('function')
    expect(backend.presets).toBeInstanceOf(Rc172PresetRepository)
    expect(backend.schedules).toBeInstanceOf(Rc172ScheduleRepository)
    expect(backend.pluginBundles).toBeInstanceOf(Rc172PluginBundleRepository)
    await backend.close()

    const olderFixture = new ProbeFixtureTransport()
    const rc171Fixture = new Rc171ProbeFixtureAdapter(adapterOptions, olderFixture)
    const olderConnected = await new VersionedBackendProbe([rc171Fixture]).probe(candidate('0.1.7-rc.1'))
    if (olderConnected === undefined) throw new Error('the exact rc171 probe declined its fixture')
    const olderBackend = await new VersionedBackendFactory([rc171Fixture]).connect(olderConnected)
    expect(olderBackend.sessions.initializeDefaultModel).toBeUndefined()
    await olderBackend.close()
  })

  it.each([
    {
      dshCode: 'session/provider-models-unavailable',
      expectedCode: 'CAPABILITY_UNAVAILABLE',
      expectedMessage: 'The DSH account provider has no available models.',
    },
    {
      dshCode: 'session/provider-credentials-unavailable',
      expectedCode: 'CAPABILITY_UNAVAILABLE',
      expectedMessage: 'The DSH host cannot inspect provider credentials for default model setup.',
    },
  ])(
    'maps the RC2 default-model initializer error $dshCode',
    async ({ dshCode, expectedCode, expectedMessage }) => {
      const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body !== 'string')
          return Promise.reject<Response>(new Error('the adapter did not send the expected request body'))
        const request = JSON.parse(init.body) as { readonly rpcId: string }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: 'server-response',
              rpcId: request.rpcId,
              result: {
                ok: false,
                error: {
                  code: dshCode,
                  message: 'The requested account model setup is unavailable.',
                  details: {},
                },
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        )
      })
      const transport = new Rc172VersionAdapter({ ...adapterOptions, fetch }).createTransport(endpoint)
      const sessions = new Rc172SessionRepository(
        transport,
        new Rc6WorkspaceRepository(transport),
        undefined,
        {},
      )

      try {
        let caught: unknown
        try {
          await sessions.initializeDefaultModel()
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(AppError)
        expect((caught as AppError).code).toBe(expectedCode)
        expect((caught as Error).message).toContain(expectedMessage)
        expect((caught as Error).message).not.toContain(dshCode)
      } finally {
        await transport.close()
      }
    },
  )

  it.each(['session/provider-models-unavailable', 'session/provider-credentials-unavailable'])(
    'keeps RC2-only error %s unknown to the RC1 adapter',
    async (dshCode) => {
      const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body !== 'string')
          return Promise.reject<Response>(new Error('the adapter did not send the expected request body'))
        const request = JSON.parse(init.body) as { readonly rpcId: string }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: 'server-response',
              rpcId: request.rpcId,
              result: {
                ok: false,
                error: { code: dshCode, message: 'unrecognized later-version error', details: {} },
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        )
      })
      const transport = new Rc171VersionAdapter({ ...adapterOptions, fetch }).createTransport(endpoint)

      try {
        const result = await transport.remoteRequest('workspace/list', {})
        expect(() => unwrapRpcResultValue(result, 'workspace/list')).toThrowError(
          expect.objectContaining({ code: 'PROTOCOL_ERROR' }),
        )
      } finally {
        await transport.close()
      }
    },
  )
})
