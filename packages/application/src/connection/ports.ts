import type {
  BackendCandidate,
  ConnectedBackend,
  ConnectionMode,
  DshBackend,
  DshRuntime,
  ManagedProcessHandle,
} from '@dsh-vscode/domain'

export interface RuntimeLocator {
  locate(signal?: AbortSignal): Promise<DshRuntime | undefined>
  searchedLocations(): readonly string[]
}

export interface BackendDiscovery {
  discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]>
}

export interface BackendProbe {
  probe(candidate: BackendCandidate, signal?: AbortSignal): Promise<ConnectedBackend | undefined>
}

export interface BackendFactory {
  connect(backend: ConnectedBackend, signal?: AbortSignal): Promise<DshBackend>
}

export interface ProcessSupervisor {
  start(runtime: DshRuntime, signal?: AbortSignal): Promise<ManagedProcessHandle>
}

export interface ConnectionRequest {
  readonly mode: ConnectionMode
  readonly autoStart: boolean
}
