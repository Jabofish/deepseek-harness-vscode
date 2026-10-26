/* The coordinator fixtures intentionally use minimal structural fakes. */
/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await, @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-argument */
import { describe, expect, it, vi } from 'vitest'
import type {
  BackendCandidate,
  BackendState,
  ConnectedBackend,
  ConnectionProgress,
  DshBackend,
  ManagedProcessHandle,
} from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'
import { DshConnectionCoordinator } from '../src/connection/dsh-connection-coordinator.js'
import type { ConnectionCoordinatorDependencies } from '../src/connection/dsh-connection-coordinator.js'

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
    expect(process.stop).toHaveBeenCalled()
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
  expect(probe.mock.calls.some(([candidate]) => candidate.endpoint.port !== selected.endpoint.port)).toBe(
    false,
  )
  expect(deps.runtimeLocator.locate).not.toHaveBeenCalled()
  expect(deps.processSupervisor.start).not.toHaveBeenCalled()
  expect(
    (await coordinator.connect({ mode: 'auto', autoStart: true, allowedEndpoints: [other.endpoint] })).state
      .backend.endpoint.port,
  ).toBe(4132)
  await coordinator.disconnect()
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
  expect(process.stop).toHaveBeenCalled()
  expect(states.at(-1)).toMatchObject({ kind: 'failed', retryable: false })
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
