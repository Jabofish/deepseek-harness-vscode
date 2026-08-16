export type OperatingSystem = 'windows' | 'linux' | 'macos'
export type ProcessOwnership = 'external' | 'managed'
export type ConnectionMode = 'auto' | 'attach-only' | 'new-isolated'

export interface DshRuntime {
  readonly executable: string
  readonly version: string
  readonly supported: boolean
  readonly source: 'configured' | 'path' | 'npm-global' | 'bundled'
}

export interface BackendEndpoint {
  readonly host: '127.0.0.1' | 'localhost'
  readonly port: number
  readonly baseUrl: string
}

export interface BackendCandidate {
  readonly endpoint: BackendEndpoint
  readonly source: 'configured' | 'known' | 'default-port' | 'process-scan' | 'companion'
  readonly pid?: number
  readonly startedAt?: string
  readonly commandLine?: string
  readonly confidence: number
}

export interface BackendCapabilities {
  readonly protocolVersion: string
  readonly dshVersion: string
  readonly features: ReadonlySet<string>
}

export interface ConnectedBackend {
  readonly endpoint: BackendEndpoint
  readonly ownership: ProcessOwnership
  readonly capabilities: BackendCapabilities
  readonly pid?: number
}

export type BackendState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'discovering'; readonly attempt: number }
  | { readonly kind: 'connecting'; readonly candidate: BackendCandidate }
  | { readonly kind: 'connected'; readonly backend: ConnectedBackend }
  | { readonly kind: 'starting'; readonly runtime: DshRuntime }
  | { readonly kind: 'runtime-missing'; readonly searchedLocations: readonly string[] }
  | { readonly kind: 'failed'; readonly message: string; readonly retryable: boolean }
  | { readonly kind: 'stopping'; readonly ownership: ProcessOwnership }

export interface ManagedProcessHandle {
  readonly pid: number
  readonly endpoint: BackendEndpoint
  readonly stop: (signal?: AbortSignal) => Promise<void>
}
