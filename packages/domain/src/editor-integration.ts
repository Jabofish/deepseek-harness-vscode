/** Public editor integration state. Contains no runtime address, filesystem path or grant identity. */
export interface EditorIntegrationPreferences {
  readonly enabled: boolean
  readonly autoSetup: boolean
  readonly allowEdits: boolean
}
export const DEFAULT_EDITOR_INTEGRATION: EditorIntegrationPreferences = {
  enabled: true,
  autoSetup: true,
  allowEdits: true,
}
export type EditorIntegrationPhase =
  'off' | 'waiting' | 'connecting' | 'ready' | 'limited' | 'setup' | 'needs-restart' | 'error'
export type EditorIntegrationReason =
  | 'disconnected'
  | 'workspace'
  | 'untrusted'
  | 'session'
  | 'unsupported'
  | 'missing'
  | 'busy'
  | 'connection'
  | 'setup-failed'
  | 'restart'
export interface EditorIntegrationStatus {
  readonly kind: 'editor.companion'
  readonly preferences: EditorIntegrationPreferences
  readonly phase: EditorIntegrationPhase
  readonly reason?: EditorIntegrationReason | undefined
  readonly version?: string | undefined
  readonly capabilities: readonly string[]
  readonly canInstall: boolean
  readonly canRestart: boolean
  readonly canUndo: boolean
}
