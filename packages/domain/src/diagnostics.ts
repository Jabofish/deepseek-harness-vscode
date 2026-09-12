import type { BackendState, ProcessOwnership } from './runtime.js'

/** Safe, bounded diagnostics data that may cross the Extension Host boundary. */
export interface DiagnosticsSnapshot {
  readonly extensionVersion: string
  readonly dshVersion?: string
  readonly state: BackendState['kind']
  /** Connected ownership or the fact that a custom endpoint is configured. */
  readonly endpointKind?: 'configured' | ProcessOwnership
  readonly canReconnect: boolean
  readonly recentEvents: readonly string[]
}
