export type ToolCallStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ToolCallView {
  readonly id: string
  /** DSH turn/step coordinates; used to close interrupted tools at turn/end. */
  readonly turn?: number
  readonly step?: number
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
  /** First item's supporting context, mirrored for single-question consumers. */
  readonly detail?: string
  /** First item's short heading, mirrored for single-question consumers. */
  readonly header?: string
  readonly choices?: readonly QuestionChoice[]
  readonly multiSelect?: boolean
  readonly allowFreeText: boolean
  /** First item's presentation intent, mirrored for single-question consumers. */
  readonly intent?: QuestionIntent
  /** All questions in the rc.6 request. `prompt` remains the first item for
   * older single-question consumers. */
  readonly items?: readonly UserQuestionItem[]
}

export interface UserQuestionItem {
  readonly id: string
  readonly prompt: string
  /** Upstream `detail`: supporting context rendered with the question but
   * kept out of option labels. For a plan-review intent it is the plan
   * markdown the caller submitted with `ask()`. */
  readonly detail?: string
  /** Upstream `header`: optional short heading/group label. */
  readonly header?: string
  readonly choices?: readonly QuestionChoice[]
  readonly multiSelect?: boolean
  readonly allowFreeText: boolean
  /** Upstream presentation intent; a UI that does not know the tag renders
   * the generic option flow. Only `plan-review` exists in the pinned rc.6. */
  readonly intent?: QuestionIntent
}

export interface QuestionChoice {
  readonly id: string
  readonly label: string
  /** Upstream `options[].description`: optional extra context a capable UI
   * renders next to the option label. */
  readonly description?: string
}

export interface QuestionIntent {
  readonly kind: 'plan-review'
  /** The option label that approves the plan; every other label declines. */
  readonly approve: string
}

export interface QuestionAnswer {
  readonly id: string
  readonly response: string | readonly string[]
  /** Free-text answer accompanying a selection (upstream `custom`); may
   * coexist with a multi-select `response`. */
  readonly custom?: string
}
