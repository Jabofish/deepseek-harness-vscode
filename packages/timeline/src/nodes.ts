import type { GoalView, JobView, SubagentView, ToolCallView } from '@dsh-vscode/domain'

export type TimelineNode =
  | { readonly kind: 'user-message'; readonly id: string; readonly markdown: string }
  | {
      readonly kind: 'assistant-message'
      readonly id: string
      readonly markdown: string
      readonly streaming: boolean
    }
  | {
      readonly kind: 'reasoning'
      readonly id: string
      readonly markdown: string
      readonly streaming: boolean
    }
  | { readonly kind: 'tool'; readonly id: string; readonly tool: ToolCallView }
  | { readonly kind: 'goal'; readonly id: string; readonly goals: readonly GoalView[] }
  | { readonly kind: 'job'; readonly id: string; readonly job: JobView }
  | { readonly kind: 'subagent'; readonly id: string; readonly subagent: SubagentView }
  | {
      readonly kind: 'notice'
      readonly id: string
      readonly level: 'info' | 'warning' | 'error'
      readonly text: string
    }

export interface TimelineState {
  readonly sessionId: string | undefined
  readonly nodes: readonly TimelineNode[]
  readonly lastSequence: number
}
