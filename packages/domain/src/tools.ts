export type ToolCallStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ToolCallView {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly title: string
  readonly status: ToolCallStatus
  readonly startedAt?: string
  readonly completedAt?: string
  readonly inputSummary?: string
  readonly outputSummary?: string
  readonly error?: string
  readonly metadata: Readonly<Record<string, unknown>>
}

export interface PermissionRequest {
  readonly id: string
  readonly sessionId: string
  readonly title: string
  readonly description: string
  readonly risk: 'low' | 'medium' | 'high'
  readonly options: readonly PermissionOption[]
}

export interface PermissionOption {
  readonly id: string
  readonly label: string
  readonly kind: 'allow-once' | 'allow-session' | 'deny'
}

export interface UserQuestion {
  readonly id: string
  readonly sessionId: string
  readonly prompt: string
  readonly choices?: readonly { readonly id: string; readonly label: string }[]
  readonly allowFreeText: boolean
}
