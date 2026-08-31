import type {
  BackendCandidate,
  BackendEndpoint,
  ConnectedBackend,
  ConnectionMode,
  DshBackend,
  DshRuntime,
  ManagedProcessHandle,
} from '@dsh-vscode/domain'

export interface RuntimeLocator {
  locate(signal?: AbortSignal): Promise<RuntimeLookupResult>
}

/** A runtime probe and the diagnostics belonging to that one probe. */
export interface RuntimeLookupResult {
  readonly runtime?: DshRuntime
  readonly searchedLocations: readonly string[]
}

export interface BackendDiscovery {
  discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]>
  /**
   * Discover candidates from bounded, non-process sources before the full
   * discovery pass. Implementations may omit this optimization; callers must
   * still wait for `discover` before starting a managed DSH process.
   */
  discoverFast?(signal?: AbortSignal): Promise<readonly BackendCandidate[]>
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
  /** Required only for `custom`; the Webview never receives this value back. */
  readonly endpoint?: BackendEndpoint
}
