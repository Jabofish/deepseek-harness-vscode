export type OperatingSystem = 'windows' | 'linux' | 'macos'
export type ProcessOwnership = 'external' | 'managed'
export type ConnectionMode = 'auto' | 'custom' | 'attach-only' | 'new-isolated'

export interface DshRuntime {
  readonly executable: string
  readonly version: string
  readonly supported: boolean
  /** `known` means covered by a pinned adapter; `unknown` remains launchable in fallback mode. */
  readonly compatibility?: 'known' | 'unknown'
  readonly source: 'configured' | 'path' | 'npm-global' | 'bundled'
}

/**
 * Browser-safe result of the Extension Host's npm update check.  It contains
 * version labels only; executable paths, registry configuration and command
 * output never cross the Host/Webview boundary.
 */
export type DshUpdateFailure = 'npm-not-found' | 'registry-unavailable' | 'invalid-response'

/**
 * Host-owned lifecycle facts for a DSH package update. npm does not expose a
 * stable byte percentage across versions, so the UI must show an indeterminate
 * progress bar instead of inventing one.
 */
export type DshRuntimeUpdatePhase =
  'checking' | 'downloading' | 'installing' | 'verifying' | 'completed' | 'failed'

export interface DshRuntimeUpdateProgress {
  readonly phase: DshRuntimeUpdatePhase
  readonly version?: string
}

export interface DshUpdateSnapshot {
  readonly status: 'ready' | 'unavailable'
  readonly currentVersion?: string
  readonly currentSource?: DshRuntime['source']
  readonly globalVersion?: string
  readonly latestVersion?: string
  readonly latestTagVersion?: string
  readonly nextTagVersion?: string
  readonly availableVersions: readonly string[]
  readonly updateAvailable: boolean
  readonly checkedAt: string
  readonly failure?: DshUpdateFailure
  readonly restartRequired?: boolean
}

export interface BackendEndpoint {
  readonly host: '127.0.0.1' | 'localhost'
  readonly port: number
  readonly baseUrl: string
}

export interface BackendCandidate {
  readonly endpoint: BackendEndpoint
  readonly source: 'configured' | 'known' | 'default-port' | 'process-scan' | 'companion'
  /** Optional host-side runtime hint; never forwarded to the Webview. */
  readonly runtimeVersion?: string
  readonly pid?: number
  readonly startedAt?: string
  readonly commandLine?: string
  readonly confidence: number
}

export interface BackendCapabilities {
  readonly protocolVersion: string
  readonly dshVersion: string
  readonly features: ReadonlySet<string>
  /** Set only when the runtime was outside the pinned compatibility range. */
  readonly compatibilityWarning?: string
}

export interface ConnectedBackend {
  readonly endpoint: BackendEndpoint
  readonly ownership: ProcessOwnership
  readonly capabilities: BackendCapabilities
  readonly pid?: number
}

export type BackendState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'locating-runtime' }
  | { readonly kind: 'discovering'; readonly attempt: number }
  | { readonly kind: 'connecting'; readonly candidate: BackendCandidate }
  | { readonly kind: 'connected'; readonly backend: ConnectedBackend }
  | { readonly kind: 'starting'; readonly runtime: DshRuntime }
  | { readonly kind: 'runtime-missing'; readonly searchedLocations: readonly string[] }
  | { readonly kind: 'failed'; readonly message: string; readonly retryable: boolean }
  | {
      readonly kind: 'port-conflict'
      readonly port: number
      readonly message: string
      readonly retryable: boolean
    }
  | { readonly kind: 'stopping'; readonly ownership: ProcessOwnership }

export interface ManagedProcessHandle {
  readonly pid: number
  readonly endpoint: BackendEndpoint
  readonly stop: (signal?: AbortSignal) => Promise<void>
}
