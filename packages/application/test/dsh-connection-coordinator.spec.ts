/* The coordinator fixtures intentionally use minimal structural fakes. */
/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await, @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-argument */
import { describe, expect, it, vi } from 'vitest'
import type { BackendCandidate, DshBackend, ManagedProcessHandle } from '@dsh-vscode/domain'
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
    runtimeLocator: { locate: vi.fn(async () => fakeRuntime()), searchedLocations: () => [] },
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
    const runtimeLocator = { locate: vi.fn(async () => fakeRuntime()), searchedLocations: () => [] }
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
        locate: vi.fn(async () => undefined),
        searchedLocations: () => ['C:\\safe\\dsh.cmd'],
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
