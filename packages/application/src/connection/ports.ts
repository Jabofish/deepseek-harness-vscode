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
   * still complete discovery before starting a managed DSH process.
   */
  discoverFast?(signal?: AbortSignal): Promise<readonly BackendCandidate[]>
  /** Bind preferred endpoint hints to current process identity without discovering other endpoints. */
  resolvePreferred?(
    candidates: readonly BackendCandidate[],
    signal?: AbortSignal,
  ): Promise<readonly BackendCandidate[]>
  /** Complete this attempt's discovery using its fast results and the remaining sources. */
  discoverRemaining?(
    fastCandidates: readonly BackendCandidate[],
    signal?: AbortSignal,
  ): Promise<readonly BackendCandidate[]>
}

export interface BackendProbe {
  probe(candidate: BackendCandidate, signal?: AbortSignal): Promise<ConnectedBackend | undefined>
}

export interface BackendFactory {
  connect(backend: ConnectedBackend, signal?: AbortSignal): Promise<DshBackend>
}

/** Host-owned authorization and transport preparation; no credential enters the request. */
export interface BackendEndpointPreparation {
  prepare(endpoint: BackendEndpoint, signal: AbortSignal): Promise<void>
  release?(endpoint: BackendEndpoint): Promise<void>
}

export interface ProcessSupervisor {
  start(runtime: DshRuntime, signal?: AbortSignal): Promise<ManagedProcessHandle>
}

export interface ConnectionRequest {
  readonly mode: ConnectionMode
  readonly autoStart: boolean
  /** Required only for `custom`; the Webview never receives this value back. */
  readonly endpoint?: BackendEndpoint
  /** Explicit local targets. Failure must never redirect to another endpoint or start an isolated instance. */
  readonly allowedEndpoints?: readonly BackendEndpoint[]
  /**
   * Optional explicit wire version for an external endpoint whose runtime
   * version cannot be discovered. Overrides the probe's version inference.
   */
  readonly runtimeVersion?: string
  /** Opaque configuration generation, never a token or cookie. */
  readonly credentialRevision?: number
}
