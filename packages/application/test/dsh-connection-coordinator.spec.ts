/* The coordinator fixtures intentionally use minimal structural fakes. */
/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await, @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-argument */
import { describe, expect, it, vi } from 'vitest'
import type {
  BackendCandidate,
  BackendEndpoint,
  BackendState,
  ConnectedBackend,
  ConnectionProgress,
  DshBackend,
  ManagedProcessHandle,
} from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'
import { DshConnectionCoordinator } from '../src/connection/dsh-connection-coordinator.js'
import type { ConnectionCoordinatorDependencies } from '../src/connection/dsh-connection-coordinator.js'

function deferred<T>() {
  let finish: ((value: T) => void) | undefined
  return {
    promise: new Promise<T>((resolve) => {
      finish = resolve
    }),
    resolve: (value: T) => finish?.(value),
  }
}

function endpoint(port = 3939) {
  return { host: '127.0.0.1' as const, port, baseUrl: `http://127.0.0.1:${port}` }
}
function fakeCandidate(port = 3939): BackendCandidate {
  return { endpoint: endpoint(port), source: 'configured', confidence: 100 }
}
function fakeConnectedBackend(port = 3939) {
  return {
    endpoint: endpoint(port),
    ownership: 'external' as const,
    capabilities: { protocolVersion: 'rc6', dshVersion: '0.1.0-rc.6', features: new Set(['sessions']) },
  }
}
function fakeRuntime() {
  return {
    executable: 'fake-dsh',
    version: '0.1.0-rc.6',
    supported: true as const,
    source: 'configured' as const,
  }
}

function backend(connection: ConnectedBackend = fakeConnectedBackend()): DshBackend {
  return {
    connection,
    sessions: {},
    workspaces: {},
    models: {},
    credentials: {},
    interactions: {},
    goals: {},
    jobs: {},
    subagents: {},
    settings: {},
    skills: {},
    commands: {},
    plugins: {},
    exports: {},
    events: { subscribe: () => () => undefined, close: async () => undefined },
    close: async () => undefined,
  } as unknown as DshBackend
}

function managedProcess(port = 4000): ManagedProcessHandle {
  return { pid: 42, endpoint: fakeConnectedBackend(port).endpoint, stop: vi.fn(async () => undefined) }
}

function dependencies(
  overrides: Partial<ConnectionCoordinatorDependencies> = {},
): ConnectionCoordinatorDependencies {
  return {
    runtimeLocator: { locate: vi.fn(async () => ({ runtime: fakeRuntime(), searchedLocations: [] })) },
    discovery: { discover: vi.fn(async () => []) },
    probe: { probe: vi.fn(async () => undefined) },
    backendFactory: { connect: vi.fn(async (connection) => backend(connection)) },
    processSupervisor: { start: vi.fn(async () => managedProcess()) },
    ...overrides,
  }
}

describe('DshConnectionCoordinator', () => {
  it('treats cache misses as unavailable candidates and starts a managed instance only after discovery', async () => {
    const candidates: readonly BackendCandidate[] = [
      fakeCandidate(4110),
      { ...fakeCandidate(4111), source: 'known' },
    ]
    const onProgress = vi.fn<(progress: ConnectionProgress) => void>()
    const process = managedProcess(4112)
    const deps = dependencies({
      onProgress,
      discovery: { discoverFast: vi.fn(async () => candidates), discover: vi.fn(async () => candidates) },
      probe: {
        probe: vi.fn(async (candidate: BackendCandidate) =>
          candidate.endpoint.port === 4112 ? fakeConnectedBackend(4112) : undefined,
        ),
      },
      processSupervisor: { start: vi.fn(async () => process) },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    const result = await coordinator.connect({ mode: 'auto', autoStart: true })
    expect(result.state.backend.ownership).toBe('managed')
    expect(onProgress).toHaveBeenCalledWith({ phase: 'discovery-cache', status: 'succeeded', count: 2 })
    expect(onProgress).toHaveBeenCalledWith({ phase: 'discovery', status: 'succeeded', count: 2 })
    expect(onProgress).toHaveBeenCalledWith({
      phase: 'verification',
      status: 'unavailable',
      attempt: 1,
      candidateSource: 'configured',
    })
    expect(onProgress).toHaveBeenCalledWith({
      phase: 'verification',
      status: 'unavailable',
      attempt: 2,
      candidateSource: 'known',
    })
    expect(onProgress.mock.calls.some(([entry]) => entry.status === 'failed')).toBe(false)
    expect(deps.processSupervisor.start).toHaveBeenCalledOnce()
    await coordinator.disconnect()
  })

  it('publishes the actual pending custom connection operation before waiting for it', async () => {
    const discovery = deferred<readonly BackendCandidate[]>()
    const authorization = deferred<void>()
    const verification = deferred<ConnectedBackend | undefined>()
    const initialization = deferred<DshBackend>()
    const onProgress = vi.fn()
    const deps = dependencies({
      onProgress,
      discovery: { discover: vi.fn(() => discovery.promise) },
      endpointPreparation: { prepare: vi.fn(() => authorization.promise) },
      probe: { probe: vi.fn(() => verification.promise) },
      backendFactory: { connect: vi.fn(() => initialization.promise) },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    const states: BackendState[] = []
    const unsubscribe = coordinator.subscribe((state) => states.push(state))
    const connecting = coordinator.connect({ mode: 'custom', endpoint: endpoint(), autoStart: false })
    expect(coordinator.getState()).toMatchObject({ kind: 'discovering', phase: 'discovery' })
    expect(deps.endpointPreparation?.prepare).not.toHaveBeenCalled()
    expect(onProgress).toHaveBeenCalledWith({ phase: 'discovery', status: 'started' })

    discovery.resolve([])
    await vi.waitFor(() =>
      expect(coordinator.getState()).toMatchObject({ kind: 'connecting', phase: 'authorization' }),
    )
    expect(deps.probe.probe).not.toHaveBeenCalled()
    expect(onProgress).toHaveBeenCalledWith({ phase: 'discovery', status: 'succeeded', count: 0 })
    authorization.resolve(undefined)
    await vi.waitFor(() =>
      expect(coordinator.getState()).toMatchObject({ kind: 'connecting', phase: 'verification' }),
    )
    expect(deps.backendFactory.connect).not.toHaveBeenCalled()
    verification.resolve(fakeConnectedBackend())
    await vi.waitFor(() =>
      expect(coordinator.getState()).toMatchObject({ kind: 'connecting', phase: 'initialization' }),
    )
    initialization.resolve(backend())
    await connecting
    expect(states.map((state) => ('phase' in state ? state.phase : state.kind))).toEqual([
      'idle',
      'discovery',
      'authorization',
      'verification',
      'initialization',
      'connected',
    ])
    unsubscribe()
    await coordinator.disconnect()
  })

  it('does not invent an authorization operation for auto discovery or revive progress after cancellation', async () => {
    const verification = deferred<ConnectedBackend | undefined>()
    const deps = dependencies({
      discovery: { discover: vi.fn(async () => [fakeCandidate()]) },
      probe: { probe: vi.fn(() => verification.promise) },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    const states: BackendState[] = []
    const unsubscribe = coordinator.subscribe((state) => states.push(state))
    const controller = new AbortController()
    const connecting = coordinator.connect({ mode: 'auto', autoStart: true }, controller.signal)
    const rejected = expect(connecting).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    await vi.waitFor(() =>
      expect(coordinator.getState()).toMatchObject({ kind: 'discovering', phase: 'verification' }),
    )
    controller.abort()
    verification.resolve(fakeConnectedBackend())
    await rejected
    expect(states.map((state) => ('phase' in state ? state.phase : state.kind))).toEqual([
      'idle',
      'discovery',
      'verification',
      'idle',
    ])
    expect(deps.backendFactory.connect).not.toHaveBeenCalled()
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('prepares credentials before probing the selected custom endpoint', async () => {
    const calls: string[] = []
    const deps = dependencies({
      endpointPreparation: {
        prepare: async () => {
          calls.push('authorize')
        },
      },
      probe: {
        probe: async () => {
          calls.push('probe')
          return fakeConnectedBackend()
        },
      },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    await coordinator.connect({ mode: 'custom', endpoint: endpoint(), autoStart: false })
    expect(calls).toEqual(['authorize', 'probe'])
    await coordinator.disconnect()
  })

  it('does not probe or start when endpoint authorization fails', async () => {
    const onProgress = vi.fn()
    const deps = dependencies({
      onProgress,
      endpointPreparation: {
        prepare: async () => {
          throw new AppError({
            code: 'PERMISSION_DENIED',
            message: 'Fixture authorization denied',
            retryable: false,
          })
        },
      },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    await expect(
      coordinator.connect({ mode: 'custom', endpoint: endpoint(), autoStart: false }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(deps.probe.probe).not.toHaveBeenCalled()
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
    expect(coordinator.getState()).toMatchObject({ kind: 'failed', retryable: false })
    expect(onProgress).toHaveBeenCalledWith({ phase: 'connect', status: 'failed', code: 'PERMISSION_DENIED' })
  })

  it.each(['runtimeVersion', 'credentialRevision'] as const)(
    'does not coalesce different %s values',
    async (field) => {
      let finish: (() => void) | undefined
      const deps = dependencies({
        endpointPreparation: {
          prepare: () =>
            new Promise<void>((resolve) => {
              finish = resolve
            }),
        },
        probe: { probe: vi.fn(async () => fakeConnectedBackend()) },
      })
      const coordinator = new DshConnectionCoordinator(deps)
      const request = {
        mode: 'custom' as const,
        endpoint: endpoint(),
        autoStart: false,
        runtimeVersion: '0.2.1-alpha.1',
        credentialRevision: 1,
      }
      const first = coordinator.connect(request)
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      const changed =
        field === 'runtimeVersion'
          ? { ...request, runtimeVersion: '0.2.1-alpha.2' }
          : { ...request, credentialRevision: 2 }
      await expect(coordinator.connect(changed)).rejects.toMatchObject({ code: 'BACKEND_BUSY' })
      finish?.()
      await first
      await coordinator.disconnect()
    },
  )

  it('replaces a cached connection when its credential revision changes', async () => {
    const probe = vi.fn(async () => fakeConnectedBackend())
    const coordinator = new DshConnectionCoordinator(dependencies({ probe: { probe } }))
    const request = { mode: 'custom' as const, endpoint: endpoint(), autoStart: false, credentialRevision: 1 }
    const first = await coordinator.connect(request)
    const cached = await coordinator.connect(request)
    expect(cached.backend).toBe(first.backend)
    const second = await coordinator.connect({ ...request, credentialRevision: 2 })
    expect(second.backend).not.toBe(first.backend)
    expect(probe).toHaveBeenCalledTimes(2)
    await coordinator.disconnect()
  })

  it('does not infer a remote runtime or PID from a local process on the same port', async () => {
    const selected = { host: 'remote.example', port: 3939, baseUrl: 'https://remote.example:3939' }
    const probe = vi.fn(async (_candidate: BackendCandidate) => ({
      ...fakeConnectedBackend(),
      endpoint: selected,
    }))
    const coordinator = new DshConnectionCoordinator(
      dependencies({
        discovery: {
          discover: async () => [
            {
              ...fakeCandidate(),
              source: 'process-scan',
              runtimeVersion: '0.2.1-alpha.1',
              runtimeVersionEvidence: 'process-manifest',
              pid: 123,
              commandLine: 'dsh',
            },
          ],
        },
        probe: { probe },
      }),
    )
    await coordinator.connect({ mode: 'custom', endpoint: selected, autoStart: false })
    expect(probe.mock.calls[0]?.[0]).not.toHaveProperty('pid')
    expect(probe.mock.calls[0]?.[0]).not.toHaveProperty('runtimeVersion')
    await coordinator.disconnect()
  })

  it('coalesces simultaneous connect calls into a single discovery/start operation', async () => {
    let release: (() => void) | undefined
    const discovery = {
      discover: vi.fn(
        () =>
          new Promise<readonly BackendCandidate[]>((resolve) => {
            release = () => resolve([])
          }),
      ),
    }
    const deps = dependencies({ discovery })
    const coordinator = new DshConnectionCoordinator(deps)
    const first = coordinator.connect({ mode: 'auto', autoStart: false })
    const second = coordinator.connect({ mode: 'auto', autoStart: false })
    release?.()
    await expect(first).rejects.toMatchObject({ code: 'NO_RUNNING_INSTANCE' })
    await expect(second).rejects.toMatchObject({ code: 'NO_RUNNING_INSTANCE' })
    expect(discovery.discover).toHaveBeenCalledTimes(1)
  })

  it('attaches to the highest-ranked healthy existing DSH before locating a runtime', async () => {
    const candidate = fakeCandidate(4100)
    const connected = fakeConnectedBackend(4100)
    const runtimeLocator = { locate: vi.fn(async () => ({ runtime: fakeRuntime(), searchedLocations: [] })) }
    const deps = dependencies({
      discovery: { discover: vi.fn(async () => [candidate]) },
      probe: { probe: vi.fn(async () => connected) },
      runtimeLocator,
    })
    const result = await new DshConnectionCoordinator(deps).connect({ mode: 'auto', autoStart: true })
    expect(result.state.backend.ownership).toBe('external')
    expect(runtimeLocator.locate).not.toHaveBeenCalled()
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
  })

  it('publishes a terminal state when authoritative discovery times out', async () => {
    const failure = new AppError({
      code: 'BACKEND_UNREACHABLE',
      message: 'DSH discovery timed out.',
      retryable: true,
      context: { timedOut: true },
    })
    const deps = dependencies({
      discovery: {
        discover: vi.fn(async () => {
          throw failure
        }),
      },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    const states: BackendState[] = []
    coordinator.subscribe((state) => states.push(state))

    await expect(coordinator.connect({ mode: 'auto', autoStart: true })).rejects.toBe(failure)

    expect(states.at(-1)).toMatchObject({ kind: 'failed', message: failure.message, retryable: true })
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
  })

  it('publishes a terminal state when backend attachment times out', async () => {
    const failure = new AppError({
      code: 'BACKEND_UNREACHABLE',
      message: 'DSH transport attachment timed out.',
      retryable: true,
      context: { timedOut: true },
    })
    const deps = dependencies({
      discovery: { discover: vi.fn(async () => [fakeCandidate(4109)]) },
      probe: { probe: vi.fn(async () => fakeConnectedBackend(4109)) },
      backendFactory: {
        connect: vi.fn(async () => {
          throw failure
        }),
      },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    const states: BackendState[] = []
    coordinator.subscribe((state) => states.push(state))

    await expect(coordinator.connect({ mode: 'auto', autoStart: false })).rejects.toBe(failure)

    expect(states.at(-1)).toMatchObject({ kind: 'failed', message: failure.message, retryable: true })
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
  })

  it('attaches from fast discovery without waiting for the slow full pass', async () => {
    const candidate: BackendCandidate = {
      ...fakeCandidate(4103),
      runtimeVersion: '0.1.7-rc.1',
      runtimeVersionEvidence: 'process-manifest',
      pid: 25143,
      commandLine: 'node /npm/node_modules/@deepseek-ai/dsh/lib/bin.js web',
    }
    const discovery = {
      discoverFast: vi.fn(async () => [candidate]),
      discover: vi.fn(() => new Promise<readonly BackendCandidate[]>(() => undefined)),
    }
    const deps = dependencies({
      discovery,
      probe: { probe: vi.fn(async () => fakeConnectedBackend(4103)) },
    })

    const result = await new DshConnectionCoordinator(deps).connect({ mode: 'auto', autoStart: true })

    expect(result.state.backend.endpoint.port).toBe(4103)
    expect(discovery.discoverFast).toHaveBeenCalledTimes(1)
    expect(discovery.discover).not.toHaveBeenCalled()
    expect(deps.runtimeLocator.locate).not.toHaveBeenCalled()
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
  })

  it('defers unversioned fast candidates and probes the same-endpoint manifest identity first', async () => {
    const fastCandidate = fakeCandidate(4107)
    const exactCandidate: BackendCandidate = {
      endpoint: endpoint(4107),
      source: 'process-scan',
      runtimeVersion: '0.1.7-rc.1',
      runtimeVersionEvidence: 'process-manifest',
      pid: 25147,
      commandLine: 'node /npm/node_modules/@deepseek-ai/dsh/lib/bin.js web',
      confidence: 70,
    }
    const discovery = {
      discoverFast: vi.fn(async () => [fastCandidate]),
      discover: vi.fn(async () => [exactCandidate]),
    }
    const probe = {
      probe: vi.fn(async (candidate: BackendCandidate) =>
        candidate.runtimeVersion === '0.1.7-rc.1' ? fakeConnectedBackend(4107) : undefined,
      ),
    }
    const deps = dependencies({ discovery, probe })

    const result = await new DshConnectionCoordinator(deps).connect({ mode: 'auto', autoStart: false })

    expect(result.state.backend.endpoint.port).toBe(4107)
    expect(discovery.discoverFast).toHaveBeenCalledTimes(1)
    expect(discovery.discover).toHaveBeenCalledTimes(1)
    expect(probe.probe).toHaveBeenCalledTimes(1)
    expect(probe.probe).toHaveBeenCalledWith(exactCandidate, expect.any(AbortSignal))
  })

  it.each([
    ['configured', 'configured'],
    ['known', 'known'],
    ['default port', 'default-port'],
  ] as const)(
    'tries an unversioned %s candidate only after full discovery confirms no manifest identity',
    async (_label, source) => {
      const candidate: BackendCandidate = { ...fakeCandidate(4108), source }
      let fullDiscoveryCompleted = false
      const discovery = {
        discoverFast: vi.fn(async () => [candidate]),
        discover: vi.fn(async () => {
          fullDiscoveryCompleted = true
          return [candidate]
        }),
      }
      const probe = {
        probe: vi.fn(async (_candidate: BackendCandidate) => {
          expect(fullDiscoveryCompleted).toBe(true)
          return fakeConnectedBackend(4108)
        }),
      }
      const deps = dependencies({ discovery, probe })

      const result = await new DshConnectionCoordinator(deps).connect({ mode: 'auto', autoStart: false })

      expect(result.state.backend.endpoint.port).toBe(4108)
      expect(discovery.discoverFast).toHaveBeenCalledTimes(1)
      expect(discovery.discover).toHaveBeenCalledTimes(1)
      expect(probe.probe).toHaveBeenCalledTimes(1)
      expect(probe.probe).toHaveBeenCalledWith(candidate, expect.any(AbortSignal))
    },
  )

  it('waits for full discovery after a fast candidate fails before starting DSH', async () => {
    const fastCandidate = fakeCandidate(4104)
    const fallbackCandidate = fakeCandidate(4105)
    let releaseFull: (() => void) | undefined
    const fullDiscovery = new Promise<readonly BackendCandidate[]>((resolve) => {
      releaseFull = () => resolve([fallbackCandidate])
    })
    const discovery = {
      discoverFast: vi.fn(async () => [fastCandidate]),
      discover: vi.fn(() => fullDiscovery),
    }
    const process = managedProcess(4106)
    const probe = {
      probe: vi.fn(async (candidate: BackendCandidate) =>
        candidate.endpoint.port === 4106 ? fakeConnectedBackend(4106) : undefined,
      ),
    }
    const deps = dependencies({
      discovery,
      probe,
      processSupervisor: { start: vi.fn(async () => process) },
    })
    const operation = new DshConnectionCoordinator(deps).connect({ mode: 'auto', autoStart: true })

    await vi.waitFor(() => expect(discovery.discover).toHaveBeenCalledTimes(1))
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
    releaseFull?.()
    await operation

    expect(probe.probe).toHaveBeenCalledTimes(3)
    expect(probe.probe.mock.calls.map(([candidate]) => candidate.endpoint.port)).toEqual([4105, 4104, 4106])
    expect(deps.processSupervisor.start).toHaveBeenCalledTimes(1)
  })

  it('reuses fast results for full discovery and refreshes records after locating the runtime', async () => {
    const initial = fakeCandidate(4116)
    const announced = fakeCandidate(4117)
    const discovery = {
      discoverFast: vi.fn().mockResolvedValueOnce([initial]).mockResolvedValueOnce([initial, announced]),
      discoverRemaining: vi.fn(async () => [initial]),
      discover: vi.fn(async () => []),
    }
    const deps = dependencies({
      discovery,
      runtimeLocator: {
        locate: vi.fn(async () => {
          expect(discovery.discoverRemaining).toHaveBeenCalledOnce()
          return { runtime: fakeRuntime(), searchedLocations: [] }
        }),
      },
      probe: {
        probe: vi.fn(async (candidate: BackendCandidate) =>
          candidate.endpoint.port === 4117 ? fakeConnectedBackend(4117) : undefined,
        ),
      },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    const result = await coordinator.connect({ mode: 'auto', autoStart: true })
    expect(result.state.backend.ownership).toBe('external')
    expect(discovery.discover).not.toHaveBeenCalled()
    expect(discovery.discoverRemaining).toHaveBeenCalledWith([initial], expect.any(AbortSignal))
    expect(discovery.discoverFast).toHaveBeenCalledTimes(2)
    expect(deps.probe.probe).toHaveBeenCalledTimes(2)
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
    await coordinator.disconnect()
  })

  it('reconnects to the last successful endpoint after current identity validation without full discovery', async () => {
    const remembered = { ...fakeCandidate(4130), source: 'known' as const }
    const verified: BackendCandidate = {
      ...remembered,
      runtimeVersion: '0.2.1-rc.2',
      runtimeVersionEvidence: 'process-manifest',
      pid: 25140,
      commandLine: '/opt/node_modules/@deepseek-ai/dsh/lib/bin.js web',
    }
    const discovery = {
      discoverFast: vi.fn(async () => [
        remembered,
        { ...fakeCandidate(3080), source: 'default-port' as const },
      ]),
      resolvePreferred: vi.fn(async () => [verified]),
      discover: vi.fn(async () => []),
    }
    const deps = dependencies({ discovery, probe: { probe: vi.fn(async () => fakeConnectedBackend(4130)) } })
    const coordinator = new DshConnectionCoordinator(deps)
    expect((await coordinator.connect({ mode: 'auto', autoStart: true })).state.backend.endpoint.port).toBe(
      4130,
    )
    expect(discovery.resolvePreferred).toHaveBeenCalledWith([remembered], expect.any(AbortSignal))
    expect(discovery.discover).not.toHaveBeenCalled()
    expect(deps.runtimeLocator.locate).not.toHaveBeenCalled()
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
    await coordinator.disconnect()
  })

  it('does not promote remembered version hints without fresh manifest evidence', async () => {
    const remembered = { ...fakeCandidate(4130), source: 'known' as const, runtimeVersion: '0.2.1-rc.2' }
    const discovery = {
      discoverFast: vi.fn(async () => [remembered]),
      resolvePreferred: vi.fn(async () => [remembered]),
      discover: vi.fn(async () => [remembered]),
    }
    const probe = vi.fn(async () => {
      expect(discovery.discover).toHaveBeenCalledOnce()
      return fakeConnectedBackend(4130)
    })
    const coordinator = new DshConnectionCoordinator(dependencies({ discovery, probe: { probe } }))
    await coordinator.connect({ mode: 'auto', autoStart: false })
    expect(probe).toHaveBeenCalledOnce()
    await coordinator.disconnect()
  })

  it('keeps explicit targets strict, releases failure, and allows changing the target', async () => {
    const selected = fakeCandidate(4131),
      other = { ...fakeCandidate(4132), source: 'known' as const }
    const probe = vi.fn(async (candidate: BackendCandidate) =>
      candidate.endpoint.port === 4132 ? fakeConnectedBackend(4132) : undefined,
    )
    const deps = dependencies({
      discovery: { discover: vi.fn(async () => [other, selected]) },
      probe: { probe },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    await expect(
      coordinator.connect({ mode: 'auto', autoStart: true, allowedEndpoints: [selected.endpoint] }),
    ).rejects.toMatchObject({ code: 'NO_RUNNING_INSTANCE' })
    expect(coordinator.getState().kind).toBe('failed')
    expect(probe.mock.calls.map(([candidate]) => candidate.endpoint.port)).toEqual([4131])
    expect(deps.runtimeLocator.locate).not.toHaveBeenCalled()
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
    expect(
      (await coordinator.connect({ mode: 'auto', autoStart: true, allowedEndpoints: [other.endpoint] })).state
        .backend.endpoint.port,
    ).toBe(4132)
    await coordinator.disconnect()
  })

  it('cancels preferred identity lookup without falling through to discovery or startup', async () => {
    const controller = new AbortController()
    const discovery = {
      discoverFast: vi.fn(async () => [{ ...fakeCandidate(), source: 'known' as const }]),
      resolvePreferred: vi.fn(async () => {
        controller.abort()
        return []
      }),
      discover: vi.fn(async () => []),
    }
    const deps = dependencies({ discovery })
    await expect(
      new DshConnectionCoordinator(deps).connect({ mode: 'auto', autoStart: true }, controller.signal),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(discovery.discover).not.toHaveBeenCalled()
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
  })

  it('does not repeat a slow process scan when discovery returns no candidates', async () => {
    const discovery = {
      discoverFast: vi.fn(async () => []),
      discoverRemaining: vi.fn(async () => []),
      discover: vi.fn(async () => []),
    }
    const deps = dependencies({ discovery, probe: { probe: vi.fn(async () => fakeConnectedBackend()) } })
    const coordinator = new DshConnectionCoordinator(deps)
    await coordinator.connect({ mode: 'auto', autoStart: true })
    expect(discovery.discoverRemaining).toHaveBeenCalledOnce()
    expect(discovery.discoverFast).toHaveBeenCalledTimes(2)
    expect(discovery.discover).not.toHaveBeenCalled()
    expect(deps.processSupervisor.start).toHaveBeenCalledOnce()
    await coordinator.disconnect()
  })

  it.each(['full', 'recheck'] as const)(
    'does not launch when cancelled during %s discovery',
    async (phase) => {
      const controller = new AbortController()
      const cancel = async () => {
        controller.abort()
        return []
      }
      const discovery = {
        discoverFast: vi.fn(async () => []).mockImplementationOnce(async () => []),
        discoverRemaining: vi.fn(async () => []),
        discover: vi.fn(async () => []),
      }
      if (phase === 'full') discovery.discoverRemaining.mockImplementationOnce(cancel)
      else discovery.discoverFast.mockImplementationOnce(cancel)
      const deps = dependencies({ discovery })
      await expect(
        new DshConnectionCoordinator(deps).connect({ mode: 'auto', autoStart: true }, controller.signal),
      ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
      expect(deps.processSupervisor.start).not.toHaveBeenCalled()
      expect(deps.backendFactory.connect).not.toHaveBeenCalled()
    },
  )

  it('falls back to a fresh full pass when fast discovery fails', async () => {
    const discovery = {
      discoverFast: vi.fn(async () => {
        throw new Error('optional source unavailable')
      }),
      discoverRemaining: vi.fn(async () => []),
      discover: vi.fn(async () => [fakeCandidate()]),
    }
    const coordinator = new DshConnectionCoordinator(
      dependencies({ discovery, probe: { probe: vi.fn(async () => fakeConnectedBackend()) } }),
    )
    await coordinator.connect({ mode: 'auto', autoStart: false })
    expect(discovery.discover).toHaveBeenCalledOnce()
    expect(discovery.discoverRemaining).not.toHaveBeenCalled()
    await coordinator.disconnect()
  })

  it('prefetches at most three probes while preserving priority and cancelling unused work', async () => {
    const first = deferred<ConnectedBackend | undefined>()
    const signals: AbortSignal[] = []
    const probe = vi.fn((candidate: BackendCandidate, signal?: AbortSignal) => {
      signals.push(signal!)
      if (candidate.endpoint.port === 4120) return first.promise
      if (candidate.endpoint.port === 4121) return Promise.resolve(fakeConnectedBackend(4121))
      return new Promise<undefined>((resolve) =>
        signal!.addEventListener('abort', () => resolve(undefined), { once: true }),
      )
    })
    const deps = dependencies({
      discovery: { discover: vi.fn(async () => [4120, 4121, 4122, 4123, 4124].map(fakeCandidate)) },
      probe: { probe },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    const connecting = coordinator.connect({ mode: 'auto', autoStart: false })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(3))
    expect(deps.backendFactory.connect).not.toHaveBeenCalled()
    first.resolve(fakeConnectedBackend(4120))
    const result = await connecting
    expect(result.state.backend.endpoint.port).toBe(4120)
    expect(probe).toHaveBeenCalledTimes(3)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(deps.backendFactory.connect).toHaveBeenCalledOnce()
    await coordinator.disconnect()
  })

  it('does not accumulate candidate wait times before using an already verified lower-ranked endpoint', async () => {
    const first = deferred<ConnectedBackend | undefined>()
    const second = deferred<ConnectedBackend | undefined>()
    const probe = vi.fn((candidate: BackendCandidate) => {
      if (candidate.endpoint.port === 4125) return first.promise
      if (candidate.endpoint.port === 4126) return second.promise
      return Promise.resolve(fakeConnectedBackend(4127))
    })
    const coordinator = new DshConnectionCoordinator(
      dependencies({
        discovery: { discover: vi.fn(async () => [4125, 4126, 4127].map(fakeCandidate)) },
        probe: { probe },
      }),
    )
    const connecting = coordinator.connect({ mode: 'auto', autoStart: false })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(3))
    second.resolve(undefined)
    first.resolve(undefined)
    expect((await connecting).state.backend.endpoint.port).toBe(4127)
    await coordinator.disconnect()
  })

  it('probes only the user-selected custom endpoint and never starts DSH', async () => {
    const selected = endpoint(4310)
    const connected = fakeConnectedBackend(4310)
    const probe = {
      probe: vi.fn(async (candidate: BackendCandidate) =>
        candidate.endpoint.port === selected.port ? connected : undefined,
      ),
    }
    const deps = dependencies({ probe })
    const coordinator = new DshConnectionCoordinator(deps)

    const result = await coordinator.connect({ mode: 'custom', autoStart: true, endpoint: selected })

    expect(result.state.backend.endpoint).toEqual(selected)
    expect(probe.probe).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: selected, source: 'configured', confidence: 120 }),
      expect.any(AbortSignal),
    )
    expect(deps.discovery.discover).toHaveBeenCalledTimes(1)
    expect(deps.runtimeLocator.locate).not.toHaveBeenCalled()
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
  })

  it('applies an explicit runtime-version override to the configured candidate', async () => {
    const selected = endpoint(4311)
    const connected = fakeConnectedBackend(4311)
    const probe = { probe: vi.fn(async () => connected) }
    const deps = dependencies({ probe })
    const coordinator = new DshConnectionCoordinator(deps)

    await coordinator.connect({
      mode: 'custom',
      autoStart: true,
      endpoint: selected,
      runtimeVersion: '0.2.1-alpha.2',
    })

    expect(probe.probe).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: selected,
        source: 'configured',
        confidence: 120,
        runtimeVersion: '0.2.1-alpha.2',
      }),
      expect.any(AbortSignal),
    )
  })

  it('borrows an exact runtime hint only from discovery of the identical custom endpoint', async () => {
    const selected = endpoint(4316)
    const discovered: BackendCandidate & { runtimeVersionEvidence: 'process-manifest' } = {
      endpoint: selected,
      source: 'process-scan',
      runtimeVersion: '0.1.7-rc.1',
      runtimeVersionEvidence: 'process-manifest',
      pid: 25140,
      commandLine: 'node /npm/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web',
      confidence: 70,
    }
    const discovery = { discover: vi.fn(async () => [discovered]) }
    const connected = fakeConnectedBackend(selected.port)
    const probe = { probe: vi.fn(async () => connected) }
    const deps = dependencies({ discovery, probe })

    await new DshConnectionCoordinator(deps).connect({ mode: 'custom', autoStart: true, endpoint: selected })

    expect(discovery.discover).toHaveBeenCalledTimes(1)
    expect(probe.probe).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: selected,
        source: 'configured',
        confidence: 120,
        runtimeVersion: '0.1.7-rc.1',
        pid: 25140,
      }),
      expect.any(AbortSignal),
    )
  })

  it.each(['configured', 'companion'] as const)(
    'uses a process-manifest identity preserved on a %s custom endpoint winner',
    async (source) => {
      const selected = endpoint(4315)
      // CompositeInstanceDiscovery keeps the preferred endpoint source while
      // attaching identity verified by a same-endpoint process scan.
      const mergedWinner: BackendCandidate = {
        endpoint: selected,
        source,
        confidence: source === 'configured' ? 100 : 60,
        runtimeVersion: '0.1.7-rc.1',
        runtimeVersionEvidence: 'process-manifest',
        pid: 25139,
        commandLine: 'node /npm/node_modules/@deepseek-ai/dsh/lib/bin.js web',
      }
      const probe = { probe: vi.fn(async () => fakeConnectedBackend(selected.port)) }
      const deps = dependencies({ discovery: { discover: vi.fn(async () => [mergedWinner]) }, probe })

      await new DshConnectionCoordinator(deps).connect({
        mode: 'custom',
        autoStart: true,
        endpoint: selected,
      })

      expect(probe.probe).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: selected,
          source: 'configured',
          runtimeVersion: '0.1.7-rc.1',
          runtimeVersionEvidence: 'process-manifest',
          pid: 25139,
        }),
        expect.any(AbortSignal),
      )
    },
  )

  it('reuses the confirmed listener hint across loopback host aliases on the same port', async () => {
    const selected = endpoint(4317)
    const loopbackAlias: BackendCandidate & { runtimeVersionEvidence: 'process-manifest' } = {
      endpoint: { host: 'localhost', port: selected.port, baseUrl: `http://localhost:${selected.port}` },
      source: 'process-scan',
      runtimeVersion: '0.1.7-rc.1',
      runtimeVersionEvidence: 'process-manifest',
      pid: 25141,
      commandLine: 'node /npm/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web',
      confidence: 70,
    }
    const probe = {
      probe: vi.fn(async (_candidate: BackendCandidate) => fakeConnectedBackend(selected.port)),
    }
    const deps = dependencies({
      discovery: { discover: vi.fn(async () => [loopbackAlias]) },
      probe,
    })

    await new DshConnectionCoordinator(deps).connect({ mode: 'custom', autoStart: true, endpoint: selected })

    expect(probe.probe).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: selected, source: 'configured', confidence: 120 }),
      expect.any(AbortSignal),
    )
    expect(probe.probe.mock.calls[0]?.[0]?.runtimeVersion).toBe('0.1.7-rc.1')
    expect(probe.probe.mock.calls[0]?.[0]?.pid).toBe(25141)
  })

  it('uses the verified process identity instead of stale companion PID and version on a custom alias', async () => {
    const selected: BackendEndpoint = {
      host: 'localhost',
      port: 4321,
      baseUrl: 'http://localhost:4321',
    }
    const processCandidate: BackendCandidate & { runtimeVersionEvidence: 'process-manifest' } = {
      endpoint: endpoint(selected.port),
      source: 'process-scan',
      runtimeVersion: '0.1.7-rc.1',
      runtimeVersionEvidence: 'process-manifest',
      pid: 101,
      commandLine: 'node /npm/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web',
      confidence: 70,
    }
    const staleCompanion: BackendCandidate = {
      endpoint: selected,
      source: 'companion',
      runtimeVersion: '0.1.7-alpha.2',
      pid: 202,
      confidence: 60,
    }
    const probe = {
      probe: vi.fn(async (_candidate: BackendCandidate) => fakeConnectedBackend(selected.port)),
    }
    const deps = dependencies({
      discovery: { discover: vi.fn(async () => [processCandidate, staleCompanion]) },
      probe,
    })

    await new DshConnectionCoordinator(deps).connect({ mode: 'custom', autoStart: true, endpoint: selected })

    expect(probe.probe.mock.calls[0]?.[0]?.runtimeVersion).toBe('0.1.7-rc.1')
    expect(probe.probe.mock.calls[0]?.[0]?.pid).toBe(101)
  })

  it('does not trust an unverified companion hint on a custom endpoint', async () => {
    const selected = endpoint(4323)
    const counterfeit: BackendCandidate = {
      endpoint: selected,
      source: 'companion',
      runtimeVersion: '0.1.7-alpha.2',
      pid: 202,
      commandLine: 'node /stale/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web',
      confidence: 60,
    }
    const probe = {
      probe: vi.fn(async (_candidate: BackendCandidate) => fakeConnectedBackend(selected.port)),
    }
    const deps = dependencies({ discovery: { discover: vi.fn(async () => [counterfeit]) }, probe })

    await new DshConnectionCoordinator(deps).connect({ mode: 'custom', autoStart: true, endpoint: selected })

    expect(probe.probe.mock.calls[0]?.[0]?.runtimeVersion).toBeUndefined()
    expect(probe.probe.mock.calls[0]?.[0]?.pid).toBeUndefined()
  })

  it('requires a complete process-manifest candidate before borrowing a custom runtime hint', async () => {
    const selected = endpoint(4324)
    const incomplete: BackendCandidate = {
      endpoint: selected,
      source: 'process-scan',
      runtimeVersion: '0.1.7-rc.1',
      runtimeVersionEvidence: 'process-manifest',
      pid: 101,
      confidence: 70,
    }
    const probe = {
      probe: vi.fn(async (_candidate: BackendCandidate) => fakeConnectedBackend(selected.port)),
    }
    const deps = dependencies({ discovery: { discover: vi.fn(async () => [incomplete]) }, probe })

    await new DshConnectionCoordinator(deps).connect({ mode: 'custom', autoStart: true, endpoint: selected })

    expect(probe.probe.mock.calls[0]?.[0]?.runtimeVersion).toBeUndefined()
    expect(probe.probe.mock.calls[0]?.[0]?.pid).toBeUndefined()
  })

  it('rejects malformed SemVer from a custom process-manifest marker', async () => {
    const selected = endpoint(4327)
    const malformed: BackendCandidate = {
      endpoint: selected,
      source: 'configured',
      runtimeVersion: '0.1.7-rc.01',
      runtimeVersionEvidence: 'process-manifest',
      pid: 101,
      commandLine: 'node /one/node_modules/@deepseek-ai/dsh/lib/bin.js web',
      confidence: 100,
    }
    const probe = {
      probe: vi.fn(async (_candidate: BackendCandidate) => fakeConnectedBackend(selected.port)),
    }
    const deps = dependencies({ discovery: { discover: vi.fn(async () => [malformed]) }, probe })

    await new DshConnectionCoordinator(deps).connect({ mode: 'custom', autoStart: true, endpoint: selected })

    expect(probe.probe.mock.calls[0]?.[0]?.runtimeVersion).toBeUndefined()
    expect(probe.probe.mock.calls[0]?.[0]?.pid).toBeUndefined()
  })

  it('fails closed on contradictory process identities for the exact custom host and port', async () => {
    const selected = endpoint(4325)
    const processCandidates: readonly BackendCandidate[] = [
      {
        endpoint: selected,
        source: 'process-scan',
        runtimeVersion: '0.1.7-rc.1',
        runtimeVersionEvidence: 'process-manifest',
        pid: 101,
        commandLine: 'node /one/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web',
        confidence: 70,
      },
      {
        endpoint: selected,
        source: 'process-scan',
        runtimeVersion: '0.1.7-alpha.2',
        runtimeVersionEvidence: 'process-manifest',
        pid: 202,
        commandLine: 'node /two/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web',
        confidence: 70,
      },
    ]
    const probe = {
      probe: vi.fn(async (_candidate: BackendCandidate) => fakeConnectedBackend(selected.port)),
    }
    const deps = dependencies({ discovery: { discover: vi.fn(async () => processCandidates) }, probe })

    await new DshConnectionCoordinator(deps).connect({ mode: 'custom', autoStart: true, endpoint: selected })

    expect(probe.probe.mock.calls[0]?.[0]?.runtimeVersion).toBeUndefined()
    expect(probe.probe.mock.calls[0]?.[0]?.pid).toBeUndefined()
  })

  it('fails closed when one custom endpoint PID has conflicting manifest versions', async () => {
    const selected = endpoint(4326)
    const candidates: readonly BackendCandidate[] = [
      {
        endpoint: selected,
        source: 'process-scan',
        runtimeVersion: '0.1.7-rc.1',
        runtimeVersionEvidence: 'process-manifest',
        pid: 101,
        commandLine: 'node /one/node_modules/@deepseek-ai/dsh/lib/bin.js web',
        confidence: 70,
      },
      {
        endpoint: selected,
        source: 'process-scan',
        runtimeVersion: '0.1.7-alpha.2',
        runtimeVersionEvidence: 'process-manifest',
        pid: 101,
        commandLine: 'node /one/node_modules/@deepseek-ai/dsh/lib/bin.js web',
        confidence: 70,
      },
    ]
    const probe = {
      probe: vi.fn(async (_candidate: BackendCandidate) => fakeConnectedBackend(selected.port)),
    }
    const deps = dependencies({ discovery: { discover: vi.fn(async () => candidates) }, probe })

    await new DshConnectionCoordinator(deps).connect({ mode: 'custom', autoStart: true, endpoint: selected })

    expect(probe.probe.mock.calls[0]?.[0]?.runtimeVersion).toBeUndefined()
    expect(probe.probe.mock.calls[0]?.[0]?.pid).toBeUndefined()
  })

  it('fails closed when multiple process-scan PIDs match a custom loopback alias', async () => {
    const selected: BackendEndpoint = {
      host: 'localhost',
      port: 4322,
      baseUrl: 'http://localhost:4322',
    }
    const processCandidates: readonly (BackendCandidate & {
      runtimeVersionEvidence: 'process-manifest'
    })[] = [
      {
        endpoint: endpoint(selected.port),
        source: 'process-scan',
        runtimeVersion: '0.1.7-rc.1',
        runtimeVersionEvidence: 'process-manifest',
        pid: 101,
        commandLine: 'node /one/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web',
        confidence: 70,
      },
      {
        endpoint: selected,
        source: 'process-scan',
        runtimeVersion: '0.1.7-rc.1',
        runtimeVersionEvidence: 'process-manifest',
        pid: 202,
        commandLine: 'node /two/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web',
        confidence: 70,
      },
    ]
    const probe = {
      probe: vi.fn(async (_candidate: BackendCandidate) => fakeConnectedBackend(selected.port)),
    }
    const deps = dependencies({ discovery: { discover: vi.fn(async () => processCandidates) }, probe })

    await new DshConnectionCoordinator(deps).connect({ mode: 'custom', autoStart: true, endpoint: selected })

    expect(probe.probe.mock.calls[0]?.[0]?.runtimeVersion).toBeUndefined()
    expect(probe.probe.mock.calls[0]?.[0]?.pid).toBeUndefined()
  })

  it('does not borrow a runtime hint from a different port', async () => {
    const selected = endpoint(4318)
    const otherPort: BackendCandidate = {
      endpoint: endpoint(4319),
      source: 'process-scan',
      runtimeVersion: '0.1.7-rc.1',
      pid: 25142,
      commandLine: 'node /npm/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web',
      confidence: 70,
    }
    const probe = {
      probe: vi.fn(async (_candidate: BackendCandidate) => fakeConnectedBackend(selected.port)),
    }
    const deps = dependencies({ discovery: { discover: vi.fn(async () => [otherPort]) }, probe })

    await new DshConnectionCoordinator(deps).connect({ mode: 'custom', autoStart: true, endpoint: selected })

    expect(probe.probe.mock.calls[0]?.[0]?.runtimeVersion).toBeUndefined()
    expect(probe.probe.mock.calls[0]?.[0]?.pid).toBeUndefined()
  })

  it('passes the operation signal through when creating the backend', async () => {
    const connected = fakeConnectedBackend(4312)
    const connect = vi.fn(async (connection: typeof connected, signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      return backend(connection)
    })
    const deps = dependencies({
      probe: { probe: vi.fn(async () => connected) },
      backendFactory: { connect },
    })

    await new DshConnectionCoordinator(deps).connect({
      mode: 'custom',
      autoStart: true,
      endpoint: connected.endpoint,
    })

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        ...connected,
        backendInstanceId: 'backend-1',
        connectionGeneration: 1,
      }),
      expect.any(AbortSignal),
    )
  })

  it('rejects custom mode without an endpoint before probing or starting DSH', async () => {
    const deps = dependencies()
    const coordinator = new DshConnectionCoordinator(deps)

    await expect(coordinator.connect({ mode: 'custom', autoStart: true })).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    })
    expect(deps.discovery.discover).not.toHaveBeenCalled()
    expect(deps.probe.probe).not.toHaveBeenCalled()
    expect(deps.runtimeLocator.locate).not.toHaveBeenCalled()
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
  })

  it('reports an unreachable custom endpoint without falling back to another DSH', async () => {
    const deps = dependencies({ probe: { probe: vi.fn(async () => undefined) } })
    const coordinator = new DshConnectionCoordinator(deps)

    await expect(
      coordinator.connect({ mode: 'custom', autoStart: true, endpoint: endpoint(4311) }),
    ).rejects.toMatchObject({ code: 'BACKEND_UNREACHABLE' })
    expect(deps.discovery.discover).toHaveBeenCalledTimes(1)
    expect(deps.runtimeLocator.locate).not.toHaveBeenCalled()
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
  })

  it('surfaces a definitive DSH_INCOMPATIBLE classification for a custom endpoint', async () => {
    const probe = {
      probe: vi.fn(async () => {
        throw new AppError({
          code: 'DSH_INCOMPATIBLE',
          message: 'The endpoint did not report a compatible DSH host version.',
          retryable: false,
        })
      }),
    }
    const deps = dependencies({ probe })
    const coordinator = new DshConnectionCoordinator(deps)
    const states: BackendState[] = []
    coordinator.subscribe((state) => states.push(state))

    await expect(
      coordinator.connect({ mode: 'custom', autoStart: true, endpoint: endpoint(4320) }),
    ).rejects.toMatchObject({ code: 'DSH_INCOMPATIBLE' })
    expect(deps.discovery.discover).toHaveBeenCalledTimes(1)
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
    expect(states.at(-1)).toMatchObject({ kind: 'failed', retryable: false })
  })

  it('stops a managed process and reports DSH_INCOMPATIBLE when the probe classifies it incompatible', async () => {
    const process = managedProcess(4322)
    const deps = dependencies({
      probe: {
        probe: vi.fn(async () => {
          throw new AppError({
            code: 'DSH_INCOMPATIBLE',
            message: 'The managed DSH process did not report a compatible host version.',
            retryable: false,
          })
        }),
      },
      processSupervisor: { start: vi.fn(async () => process) },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    const states: BackendState[] = []
    coordinator.subscribe((state) => states.push(state))

    await expect(coordinator.connect({ mode: 'auto', autoStart: true })).rejects.toMatchObject({
      code: 'DSH_INCOMPATIBLE',
    })
    expect(process.stop).toHaveBeenCalledTimes(1)
    expect(states.at(-1)).toMatchObject({ kind: 'failed', retryable: false })
  })

  it('publishes a failed state when a managed probe fails without a classification', async () => {
    // A probe timeout against the managed endpoint rejects with a retryable
    // transport error. Every terminal connect failure publishes a failed
    // state before throwing; skipping it would leave the last published
    // snapshot on 'starting' while the operation already failed.
    const process = managedProcess(4324)
    const deps = dependencies({
      probe: {
        probe: vi.fn(async () => {
          throw new AppError({
            code: 'BACKEND_UNREACHABLE',
            message: 'The DSH request host.describe timed out.',
            retryable: true,
            context: { method: 'host.describe', timedOut: true },
          })
        }),
      },
      processSupervisor: { start: vi.fn(async () => process) },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    const states: BackendState[] = []
    coordinator.subscribe((state) => states.push(state))

    await expect(coordinator.connect({ mode: 'auto', autoStart: true })).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
    })
    expect(process.stop).toHaveBeenCalledTimes(1)
    expect(states.at(-1)).toMatchObject({ kind: 'failed', retryable: true })
  })

  it('re-publishes connected state when a cached backend is reused', async () => {
    const connected = fakeConnectedBackend(4110)
    const deps = dependencies({
      discovery: { discover: vi.fn(async () => [fakeCandidate(4110)]) },
      probe: { probe: vi.fn(async () => connected) },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    await coordinator.connect({ mode: 'auto', autoStart: false })
    const states: string[] = []
    coordinator.subscribe((state) => states.push(state.kind))

    const result = await coordinator.connect({ mode: 'auto', autoStart: false })

    expect(result.state.kind).toBe('connected')
    expect(states).toEqual(['connected', 'connected'])
  })

  it('honors cancellation before returning a cached backend', async () => {
    const connected = fakeConnectedBackend(4111)
    const deps = dependencies({
      discovery: { discover: vi.fn(async () => [fakeCandidate(4111)]) },
      probe: { probe: vi.fn(async () => connected) },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    await coordinator.connect({ mode: 'auto', autoStart: false })

    const controller = new AbortController()
    controller.abort()

    await expect(
      coordinator.connect({ mode: 'auto', autoStart: false }, controller.signal),
    ).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    })
    expect(deps.discovery.discover).toHaveBeenCalledTimes(1)
  })

  it('does not disconnect the current backend for an already-cancelled replacement', async () => {
    const close = vi.fn(async () => undefined)
    const deps = dependencies({
      discovery: { discover: vi.fn(async () => [fakeCandidate(4112)]) },
      probe: { probe: vi.fn(async () => fakeConnectedBackend(4112)) },
      backendFactory: { connect: vi.fn(async (connection) => ({ ...backend(connection), close })) },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    const current = await coordinator.connect({ mode: 'auto', autoStart: false })
    const controller = new AbortController()
    controller.abort()

    await expect(
      coordinator.connect({ mode: 'new-isolated', autoStart: true }, controller.signal),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })

    expect(coordinator.getState()).toMatchObject({ kind: 'connected', backend: current.state.backend })
    expect(close).not.toHaveBeenCalled()
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
  })

  it('falls through unhealthy candidates without starting early', async () => {
    const first = fakeCandidate(4101)
    const second = fakeCandidate(4102)
    const probe = {
      probe: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(fakeConnectedBackend(4102)),
    }
    const deps = dependencies({ discovery: { discover: vi.fn(async () => [first, second]) }, probe })
    const result = await new DshConnectionCoordinator(deps).connect({ mode: 'auto', autoStart: true })
    expect(probe.probe).toHaveBeenCalledTimes(2)
    expect(result.state.backend.endpoint.port).toBe(4102)
  })

  it('publishes strictly advancing phases when a discovered candidate is unhealthy', async () => {
    // The flow used to publish `connecting` while still probing discovered
    // candidates, so an unhealthy first pass rolled the stage indicator back
    // from connecting to locating-runtime. Probing a discovered instance is
    // still part of finding one; `connecting` belongs to the managed attach.
    const stale = fakeCandidate(4106)
    const process = managedProcess(4107)
    const deps = dependencies({
      discovery: { discover: vi.fn(async () => [stale]) },
      probe: {
        probe: vi.fn(async (candidate: BackendCandidate) =>
          candidate.endpoint.port === 4107 ? fakeConnectedBackend(4107) : undefined,
        ),
      },
      processSupervisor: { start: vi.fn(async () => process) },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    const kinds: string[] = []
    coordinator.subscribe((state) => {
      if (kinds.at(-1) !== state.kind) kinds.push(state.kind)
    })

    await coordinator.connect({ mode: 'auto', autoStart: true })

    // The first emission is the replayed current state, not a transition.
    expect(kinds.slice(1)).toEqual(['discovering', 'locating-runtime', 'starting', 'connecting', 'connected'])
    expect(deps.processSupervisor.start).toHaveBeenCalledTimes(1)
  })

  it('publishes a failed state when the runtime lookup itself fails', async () => {
    // A locate failure used to reject with no published state at all, so the
    // Webview stayed on the locating-runtime skeleton while app.ready already
    // carried an error. The error must keep travelling unchanged.
    const failures: readonly unknown[] = [
      new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'Timed out while checking the DSH runtime version.',
        retryable: true,
      }),
      new Error('spawn EINVAL'),
    ]
    for (const failure of failures) {
      const deps = dependencies({
        runtimeLocator: {
          locate: vi.fn(async () => {
            throw failure
          }),
        },
      })
      const coordinator = new DshConnectionCoordinator(deps)
      const states: BackendState[] = []
      coordinator.subscribe((state) => states.push(state))

      await expect(coordinator.connect({ mode: 'auto', autoStart: true })).rejects.toBe(failure)
      expect(states.at(-1)).toMatchObject({
        kind: 'failed',
        retryable: true,
        message: failure instanceof AppError ? failure.message : 'The DSH runtime could not be located.',
      })
    }
  })

  it('never starts DSH in attach-only mode', async () => {
    const deps = dependencies()
    const coordinator = new DshConnectionCoordinator(deps)
    await expect(coordinator.connect({ mode: 'attach-only', autoStart: true })).rejects.toMatchObject({
      code: 'NO_RUNNING_INSTANCE',
    })
    expect(deps.runtimeLocator.locate).not.toHaveBeenCalled()
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
  })

  it('always starts an isolated managed DSH in new-isolated mode', async () => {
    const process = managedProcess(4200)
    const deps = dependencies({
      processSupervisor: { start: vi.fn(async () => process) },
      probe: { probe: vi.fn(async () => fakeConnectedBackend(4200)) },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    const result = await coordinator.connect({ mode: 'new-isolated', autoStart: true })
    expect(deps.discovery.discover).not.toHaveBeenCalled()
    expect(deps.processSupervisor.start).toHaveBeenCalledTimes(1)
    expect(result.state.backend.ownership).toBe('managed')
  })

  it('publishes runtime-missing with safe searched paths when no binary exists', async () => {
    const states: string[] = []
    const deps = dependencies({
      runtimeLocator: {
        locate: vi.fn(async () => ({ searchedLocations: ['C:\\safe\\dsh.cmd'] })),
      },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    coordinator.subscribe((state) => states.push(state.kind))
    await expect(coordinator.connect({ mode: 'auto', autoStart: true })).rejects.toMatchObject({
      code: 'DSH_NOT_FOUND',
    })
    expect(coordinator.getState()).toMatchObject({
      kind: 'runtime-missing',
      searchedLocations: ['C:\\safe\\dsh.cmd'],
    })
    expect(states).toContain('runtime-missing')
  })

  it('disconnects streams but does not stop an external DSH process', async () => {
    const close = vi.fn(async () => undefined)
    const external = { ...backend(), close }
    const deps = dependencies({
      discovery: { discover: vi.fn(async () => [fakeCandidate()]) },
      probe: { probe: vi.fn(async () => fakeConnectedBackend()) },
      backendFactory: { connect: vi.fn(async () => external) },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    await coordinator.connect({ mode: 'auto', autoStart: false })
    await coordinator.disconnect()
    expect(close).toHaveBeenCalledTimes(1)
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
  })

  it('stops only the exact managed child on disconnect', async () => {
    const process = managedProcess(4300)
    const deps = dependencies({
      processSupervisor: { start: vi.fn(async () => process) },
      probe: { probe: vi.fn(async () => fakeConnectedBackend(4300)) },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    await coordinator.connect({ mode: 'new-isolated', autoStart: true })
    await coordinator.disconnect()
    expect(process.stop).toHaveBeenCalledTimes(1)
  })

  it('retains and retries a managed process handle when stopping fails', async () => {
    const stop = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary stop failure'))
      .mockResolvedValue(undefined)
    const process = { ...managedProcess(4300), stop }
    const close = vi.fn(async () => undefined)
    const deps = dependencies({
      processSupervisor: { start: vi.fn(async () => process) },
      probe: { probe: vi.fn(async () => fakeConnectedBackend(4300)) },
      backendFactory: {
        connect: vi.fn(async (connection) => ({ ...backend(connection), close })),
      },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    await coordinator.connect({ mode: 'new-isolated', autoStart: true })

    await expect(coordinator.disconnect()).rejects.toThrow('temporary stop failure')
    expect(coordinator.getState()).toMatchObject({ kind: 'failed', retryable: true })
    await coordinator.disconnect()

    expect(close).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(2)
    expect(coordinator.getState()).toEqual({ kind: 'idle' })
  })

  it('retains and retries a backend handle when closing fails', async () => {
    const process = managedProcess(4300)
    const stop = vi.fn(async () => undefined)
    const close = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary close failure'))
      .mockResolvedValue(undefined)
    const deps = dependencies({
      processSupervisor: { start: vi.fn(async () => ({ ...process, stop })) },
      probe: { probe: vi.fn(async () => fakeConnectedBackend(4300)) },
      backendFactory: {
        connect: vi.fn(async (connection) => ({ ...backend(connection), close })),
      },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    await coordinator.connect({ mode: 'new-isolated', autoStart: true })

    await expect(coordinator.disconnect()).rejects.toThrow('temporary close failure')
    expect(coordinator.getState()).toMatchObject({ kind: 'failed', retryable: true })
    await coordinator.disconnect()

    expect(close).toHaveBeenCalledTimes(2)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(coordinator.getState()).toEqual({ kind: 'idle' })
  })

  it('preserves both close and stop failures and retries both retained handles', async () => {
    const closeError = new Error('temporary close failure')
    const stopError = new Error('temporary stop failure')
    const process = managedProcess(4300)
    const stop = vi.fn().mockRejectedValueOnce(stopError).mockResolvedValue(undefined)
    const close = vi.fn().mockRejectedValueOnce(closeError).mockResolvedValue(undefined)
    const deps = dependencies({
      processSupervisor: { start: vi.fn(async () => ({ ...process, stop })) },
      probe: { probe: vi.fn(async () => fakeConnectedBackend(4300)) },
      backendFactory: {
        connect: vi.fn(async (connection) => ({ ...backend(connection), close })),
      },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    await coordinator.connect({ mode: 'new-isolated', autoStart: true })

    const failure = await coordinator.disconnect().then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([closeError, stopError])
    expect(coordinator.getState()).toMatchObject({ kind: 'failed', retryable: true })

    await coordinator.disconnect()

    expect(close).toHaveBeenCalledTimes(2)
    expect(stop).toHaveBeenCalledTimes(2)
    expect(coordinator.getState()).toEqual({ kind: 'idle' })
  })

  it('cancels discovery and does not start a process', async () => {
    const controller = new AbortController()
    const deps = dependencies({
      discovery: {
        discover: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          return []
        }),
      },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    const operation = coordinator.connect({ mode: 'auto', autoStart: true }, controller.signal)
    controller.abort()
    await expect(operation).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
  })

  it('settles to idle when discovery resolves after cancellation', async () => {
    let release: ((candidates: readonly BackendCandidate[]) => void) | undefined
    const controller = new AbortController()
    const deps = dependencies({
      discovery: {
        discover: vi.fn(
          () =>
            new Promise<readonly BackendCandidate[]>((resolve) => {
              release = resolve
            }),
        ),
      },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    const operation = coordinator.connect({ mode: 'auto', autoStart: false }, controller.signal)

    expect(coordinator.getState()).toMatchObject({ kind: 'discovering' })
    controller.abort()
    release?.([])

    await expect(operation).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(coordinator.getState()).toEqual({ kind: 'idle' })
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
  })

  it('retains a managed process when failed connection cleanup needs retry', async () => {
    const stop = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary stop failure'))
      .mockResolvedValue(undefined)
    const process = { ...managedProcess(4330), stop }
    const deps = dependencies({
      processSupervisor: { start: vi.fn(async () => process) },
      probe: {
        probe: vi.fn(async () => {
          throw new AppError({
            code: 'BACKEND_UNREACHABLE',
            message: 'The DSH readiness probe timed out.',
            retryable: true,
          })
        }),
      },
    })
    const coordinator = new DshConnectionCoordinator(deps)

    await expect(coordinator.connect({ mode: 'auto', autoStart: true })).rejects.toMatchObject({
      code: 'PROCESS_FAILED',
      retryable: true,
    })
    expect(coordinator.getState()).toMatchObject({ kind: 'failed', retryable: true })

    await coordinator.disconnect()

    expect(stop).toHaveBeenCalledTimes(2)
    expect(coordinator.getState()).toEqual({ kind: 'idle' })
  })

  it('retains a stale backend handle when cancellation cleanup fails', async () => {
    let releaseFactory: (() => void) | undefined
    let factoryStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      factoryStarted = resolve
    })
    const close = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary close failure'))
      .mockResolvedValue(undefined)
    let attachmentCount = 0
    const deps = dependencies({
      discovery: { discover: vi.fn(async () => [fakeCandidate(4333)]) },
      probe: { probe: vi.fn(async () => fakeConnectedBackend(4333)) },
      backendFactory: {
        connect: vi.fn((connection: ConnectedBackend) => {
          attachmentCount += 1
          if (attachmentCount > 1) return Promise.resolve(backend(connection))
          return new Promise<DshBackend>((resolve) => {
            releaseFactory = () => resolve({ ...backend(connection), close })
            factoryStarted?.()
          })
        }),
      },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    const controller = new AbortController()
    const operation = coordinator.connect({ mode: 'auto', autoStart: false }, controller.signal)
    await started
    controller.abort()
    releaseFactory?.()

    await expect(operation).rejects.toMatchObject({ code: 'PROCESS_FAILED', retryable: true })
    expect(coordinator.getState()).toMatchObject({ kind: 'failed', retryable: true })

    const retried = await coordinator.connect({ mode: 'auto', autoStart: false })

    expect(close).toHaveBeenCalledTimes(2)
    expect(retried.state.kind).toBe('connected')
    await coordinator.disconnect()
    expect(coordinator.getState()).toEqual({ kind: 'idle' })
  })

  it('does not start a replacement after a concurrent disconnect supersedes it', async () => {
    let releaseClose: (() => void) | undefined
    let closeStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      closeStarted = resolve
    })
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve
          closeStarted?.()
        }),
    )
    const deps = dependencies({
      discovery: { discover: vi.fn(async () => [fakeCandidate(4331)]) },
      probe: { probe: vi.fn(async () => fakeConnectedBackend(4331)) },
      backendFactory: { connect: vi.fn(async (connection) => ({ ...backend(connection), close })) },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    await coordinator.connect({ mode: 'auto', autoStart: false })

    const replacement = coordinator.connect({ mode: 'new-isolated', autoStart: true })
    await started
    const disconnect = coordinator.disconnect()
    releaseClose?.()

    await disconnect
    await expect(replacement).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
    expect(coordinator.getState()).toEqual({ kind: 'idle' })
  })

  it('coalesces replacement requests waiting on the same teardown', async () => {
    let releaseClose: (() => void) | undefined
    let closeStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      closeStarted = resolve
    })
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve
          closeStarted?.()
        }),
    )
    const process = managedProcess(4332)
    const deps = dependencies({
      discovery: { discover: vi.fn(async () => [fakeCandidate(4331)]) },
      probe: {
        probe: vi.fn(async (candidate: BackendCandidate) => fakeConnectedBackend(candidate.endpoint.port)),
      },
      backendFactory: {
        connect: vi.fn(async (connection: ConnectedBackend) =>
          connection.endpoint.port === 4331 ? { ...backend(connection), close } : backend(connection),
        ),
      },
      processSupervisor: { start: vi.fn(async () => process) },
    })
    const coordinator = new DshConnectionCoordinator(deps)
    await coordinator.connect({ mode: 'auto', autoStart: false })

    const request = { mode: 'new-isolated' as const, autoStart: true }
    const first = coordinator.connect(request)
    await started
    const second = coordinator.connect(request)
    releaseClose?.()

    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult.backend).toBe(secondResult.backend)
    expect(deps.processSupervisor.start).toHaveBeenCalledTimes(1)
  })
})
