/* The coordinator fixtures intentionally use minimal structural fakes. */
/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await, @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-argument */
import { describe, expect, it, vi } from 'vitest'
import type { BackendCandidate, BackendState, DshBackend, ManagedProcessHandle } from '@dsh-vscode/domain'
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

function backend(connection = fakeConnectedBackend()): DshBackend {
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

  it('attaches from fast discovery without waiting for the slow full pass', async () => {
    const candidate = fakeCandidate(4103)
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
    expect(deps.processSupervisor.start).toHaveBeenCalledTimes(1)
  })

  it('probes only the user-selected custom endpoint and never discovers or starts DSH', async () => {
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
    expect(deps.discovery.discover).not.toHaveBeenCalled()
    expect(deps.runtimeLocator.locate).not.toHaveBeenCalled()
    expect(deps.processSupervisor.start).not.toHaveBeenCalled()
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
    expect(deps.discovery.discover).not.toHaveBeenCalled()
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
    expect(deps.discovery.discover).not.toHaveBeenCalled()
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
})
