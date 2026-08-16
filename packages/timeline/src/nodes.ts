import type {
  CompactionView,
  GoalView,
  JobView,
  SubagentView,
  TodoView,
  TokenUsage,
  ToolCallView,
} from '@dsh-vscode/domain'

export type TimelineNode =
  | {
      readonly kind: 'user-message'
      readonly id: string
      readonly markdown: string
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
      readonly modelLabel?: string
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
  | { readonly kind: 'tool'; readonly id: string; readonly tool: ToolCallView }
  | { readonly kind: 'goal'; readonly id: string; readonly goals: readonly GoalView[] }
  | { readonly kind: 'todo'; readonly id: string; readonly todos: readonly TodoView[] }
  | { readonly kind: 'compaction'; readonly id: string; readonly compaction: CompactionView }
  | { readonly kind: 'job'; readonly id: string; readonly job: JobView }
  | { readonly kind: 'subagent'; readonly id: string; readonly subagent: SubagentView }
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
}
