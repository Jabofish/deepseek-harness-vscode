import type { BackendState, DshBackend } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type {
  BackendDiscovery,
  BackendFactory,
  BackendProbe,
  ConnectionRequest,
  ProcessSupervisor,
  RuntimeLocator,
} from './ports.js'

export interface ConnectionCoordinatorDependencies {
  readonly runtimeLocator: RuntimeLocator
  readonly discovery: BackendDiscovery
  readonly probe: BackendProbe
  readonly backendFactory: BackendFactory
  readonly processSupervisor: ProcessSupervisor
}

export interface ConnectionResult {
  readonly backend: DshBackend
  readonly state: Extract<BackendState, { readonly kind: 'connected' }>
}

export class DshConnectionCoordinator {
  private state: BackendState = { kind: 'idle' }
  private readonly listeners = new Set<(state: BackendState) => void>()

  public constructor(private readonly dependencies: ConnectionCoordinatorDependencies) {}

  public getState(): BackendState {
    return this.state
  }

  public subscribe(listener: (state: BackendState) => void): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  public async connect(request: ConnectionRequest, signal?: AbortSignal): Promise<ConnectionResult> {
    return unimplemented<Promise<ConnectionResult>>('connection coordinator attach-before-spawn flow', [
      'serialize concurrent connect attempts into one in-flight promise',
      'unless mode is new-isolated, discover and health-check every eligible local DSH instance first',
      'rank configured and verified instances deterministically and attach without starting a duplicate',
      'in attach-only mode, never locate or spawn a runtime after candidates are exhausted',
      'when spawning is allowed, locate a compatible DSH binary and publish runtime-missing when absent',
      'start dsh web on loopback, capture its resolved port, wait for readiness, then create the adapter',
      'record external versus managed ownership and never stop externally-owned processes',
      'propagate AbortSignal and convert expected failures into explicit BackendState variants',
      'cover candidate fallback, races, timeouts, cancellation, and ownership with unit tests',
      `request mode is ${request.mode}; autoStart is ${String(request.autoStart)}; signal present ${String(signal !== undefined)}`,
      `dependency ports available: ${Object.keys(this.dependencies).join(', ')}`,
    ])
  }

  public async disconnect(): Promise<void> {
    return unimplemented<Promise<void>>('connection coordinator disconnect', [
      'close event streams and client resources',
      'stop only a backend whose ownership is managed',
      'leave external DSH processes running',
      'transition atomically back to idle',
    ])
  }

  private publish(state: BackendState): void {
    this.state = state
    for (const listener of this.listeners) listener(state)
  }
}
