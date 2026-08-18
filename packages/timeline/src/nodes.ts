import type {
  CompactionView,
  GoalView,
  MessageAttachment,
  TodoView,
  TokenUsage,
  ToolCallView,
  WorkflowSummary,
} from '@dsh-vscode/domain'

/**
 * Aggregated model-retry status row. Consecutive retry signals collapse into
 * one producer-correlated row. It persists with its scheduled/started state;
 * a scheduled wait becomes cancelled if its owning step closes first.
 */
export interface ModelRetryNode {
  readonly kind: 'retry'
  readonly id: string
  readonly sequence?: number
  readonly turn: number
  readonly step: number
  readonly attempt: number
  readonly state: 'scheduled' | 'started' | 'cancelled'
  readonly delayMs?: number
  readonly maxRetries?: number
  readonly message?: string
}

/** The durable DSH boundaries used by chat and trajectory timing displays. */
export interface AssistantTiming {
  readonly stepStartTime: number | null
  readonly firstTokenTime: number | null
  readonly completedTime: number | null
}

export type TimelineNode =
  | {
      readonly kind: 'user-message'
      readonly id: string
      readonly markdown: string
      readonly attachments?: readonly MessageAttachment[]
      readonly rpcId?: string
      readonly source?: string
      readonly sourceForm?: string
      readonly sourceSummary?: string
    }
  | {
      readonly kind: 'assistant-message'
      readonly id: string
      readonly markdown: string
      readonly streaming: boolean
      /** Durable event sequence used as the rc.6 session.fork anchor. */
      readonly sequence?: number
      /** DSH coordinates keep step and turn completion separate. */
      readonly turn?: number
      readonly step?: number
      /** Set only after the durable turn/end boundary closes this turn. */
      readonly turnCompleted?: boolean
      readonly modelLabel?: string
      readonly usage?: TokenUsage
      readonly timing?: AssistantTiming
      readonly reasoning?: {
        readonly markdown: string
        readonly streaming: boolean
      }
    }
  | {
      readonly kind: 'reasoning'
      readonly id: string
      readonly markdown: string
      readonly streaming: boolean
    }
  | { readonly kind: 'tool'; readonly id: string; readonly tool: ToolCallView; readonly sequence?: number }
  | { readonly kind: 'goal'; readonly id: string; readonly goals: readonly GoalView[] }
  | { readonly kind: 'todo'; readonly id: string; readonly todos: readonly TodoView[] }
  | { readonly kind: 'compaction'; readonly id: string; readonly compaction: CompactionView }
  | ModelRetryNode
  | { readonly kind: 'workflow'; readonly id: string; readonly workflow: WorkflowSummary }
  | {
      readonly kind: 'notice'
      readonly id: string
      readonly level: 'info' | 'warning' | 'error'
      readonly text: string
    }
  | {
      readonly kind: 'event'
      readonly id: string
      readonly name: string
      readonly payload: unknown
    }

export interface TimelineState {
  readonly sessionId: string | undefined
  readonly nodes: readonly TimelineNode[]
  readonly lastSequence: number
  readonly tokenUsage?: TokenUsage
  /** In-flight step boundaries waiting for their assistant message. */
  readonly stepTimings?: Readonly<Record<string, AssistantTiming>>
  /** Durable turn currently open; message.completed only closes a step. */
  readonly activeTurn?: number
  /** Prevent late durable projections from reopening a closed turn. */
  readonly closedTurns?: readonly number[]
}
