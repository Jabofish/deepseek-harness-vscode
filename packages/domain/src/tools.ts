export type ToolCallStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ToolLocationView {
  readonly path: string
  readonly line?: number
}

/**
 * Adapter-owned projection of DSH's provider-neutral tool render intent.
 *
 * The upstream view is deliberately not exposed across the application
 * boundary: it contains arbitrary ContentBlock values and may grow with a
 * newer DSH. These bounded text/row models keep the domain platform-neutral,
 * make rc.6's absence of a view harmless, and let newer cards fall back to
 * the ordinary tool summary when they are not understood.
 */
export type ToolPresentationView =
  | {
      readonly phase: 'call'
      readonly card: 'generic'
      readonly title?: string
      readonly kind?: string
      readonly rawInput?: string
      readonly content?: readonly string[]
      readonly locations?: readonly ToolLocationView[]
    }
  | {
      readonly phase: 'call'
      readonly card: 'terminal'
      readonly title: string
      readonly description?: string
      readonly cwd?: string
    }
  | {
      readonly phase: 'call'
      readonly card: 'diff'
      readonly title: string
      readonly diffs: readonly ToolPresentationDiff[]
      readonly locations?: readonly ToolLocationView[]
    }
  | {
      readonly phase: 'result'
      readonly card: 'generic'
      readonly title?: string
      readonly content?: readonly string[]
    }
  | {
      readonly phase: 'result'
      readonly card: 'terminal'
      readonly title?: string
      readonly output?: string
      readonly exitCode?: number
      readonly signal?: string
    }
  | {
      readonly phase: 'result'
      readonly card: 'diff'
      readonly title?: string
      readonly diffs: readonly ToolPresentationDiff[]
    }
  | {
      readonly phase: 'result'
      readonly card: 'search'
      readonly shape: 'matches'
      readonly title?: string
      readonly files: readonly ToolPresentationSearchFile[]
      readonly truncated: boolean
      readonly total: number
    }
  | {
      readonly phase: 'result'
      readonly card: 'search'
      readonly shape: 'paths'
      readonly title?: string
      readonly paths: readonly string[]
      readonly truncated: boolean
      readonly total: number
    }
  | {
      readonly phase: 'result'
      readonly card: 'read'
      readonly title?: string
      readonly path: string
      readonly offset: number
      readonly lines: readonly ToolPresentationLine[]
      readonly totalLines: number
      readonly lang?: string
      readonly content?: readonly string[]
    }
  | {
      readonly phase: 'result'
      readonly card: 'web'
      readonly kind: 'search'
      readonly title?: string
      readonly sources: readonly ToolPresentationSource[]
      readonly answer?: string
      readonly truncated: boolean
    }
  | {
      readonly phase: 'result'
      readonly card: 'web'
      readonly kind: 'fetch'
      readonly title?: string
      readonly url: string
      readonly statusCode: number
      readonly truncated: boolean
    }

export interface ToolPresentationDiff {
  readonly path: string
  readonly oldText: string | null
  readonly newText: string
}

export interface ToolPresentationLine {
  readonly number: number
  readonly text: string
}

export interface ToolPresentationSearchFile {
  readonly path: string
  readonly matches: readonly ToolPresentationSearchMatch[]
}

export interface ToolPresentationSearchMatch {
  readonly lineNumber: number
  readonly line: string
}

export interface ToolPresentationSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
}

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
  /** Host-safe file locations emitted by mutation tool cards. */
  readonly locations?: readonly ToolLocationView[]
  /** Bounded DSH render intent; absent on rc.6 and unknown future cards. */
  readonly presentation?: ToolPresentationView
  readonly metadata: Readonly<Record<string, unknown>>
}

export interface PermissionRequest {
  readonly id: string
  readonly rpcId?: string
  readonly sessionId: string
  readonly title: string
  readonly description: string
  /** Optional provider-supplied command preview; rc.6 normally omits it. */
  readonly commandLine?: string
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
