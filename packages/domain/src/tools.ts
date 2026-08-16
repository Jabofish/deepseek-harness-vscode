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
  readonly rpcId?: string
  readonly sessionId: string
  readonly title: string
  readonly description: string
  readonly risk: 'low' | 'medium' | 'high'
  readonly options: readonly PermissionOption[]
}

export interface PermissionOption {
  readonly id: string
  readonly label: string
  readonly kind: 'allow-once' | 'deny'
}

export interface UserQuestion {
  readonly id: string
  readonly rpcId?: string
  readonly sessionId: string
  readonly prompt: string
  readonly choices?: readonly { readonly id: string; readonly label: string }[]
  readonly multiSelect?: boolean
  readonly allowFreeText: boolean
  /** All questions in the rc.6 request. `prompt` remains the first item for
   * older single-question consumers. */
  readonly items?: readonly UserQuestionItem[]
}

export interface UserQuestionItem {
  readonly id: string
  readonly prompt: string
  readonly choices?: readonly { readonly id: string; readonly label: string }[]
  readonly multiSelect?: boolean
  readonly allowFreeText: boolean
}

export interface QuestionAnswer {
  readonly id: string
  readonly response: string | readonly string[]
}
