import type { WorkflowSummary } from './advanced.js'
import type { QueuedInput } from './sessions.js'
import type { PermissionRequest, ToolCallView, UserQuestion } from './tools.js'

export interface GoalView {
  readonly id: string
  readonly title: string
  readonly status: 'pending' | 'in-progress' | 'completed' | 'blocked'
}

export interface JobView {
  readonly id: string
  readonly label: string
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled'
  readonly progress?: number
}

export interface SubagentView {
  readonly id: string
  readonly label: string
  readonly status: 'idle' | 'running' | 'awaiting-input' | 'completed' | 'failed'
  readonly parentSessionId: string
}

export type BackendEvent =
  | { readonly type: 'session.status'; readonly sessionId: string; readonly status: string }
  | {
      readonly type: 'message.delta'
      readonly sessionId: string
      readonly messageId: string
      readonly delta: string
    }
  | { readonly type: 'message.completed'; readonly sessionId: string; readonly messageId: string }
  | { readonly type: 'tool.updated'; readonly sessionId: string; readonly tool: ToolCallView }
  | { readonly type: 'permission.requested'; readonly request: PermissionRequest }
  | { readonly type: 'question.requested'; readonly question: UserQuestion }
  | { readonly type: 'goal.updated'; readonly sessionId: string; readonly goals: readonly GoalView[] }
  | { readonly type: 'job.updated'; readonly sessionId: string; readonly job: JobView }
  | { readonly type: 'subagent.updated'; readonly sessionId: string; readonly subagent: SubagentView }
  | { readonly type: 'queue.updated'; readonly sessionId: string; readonly items: readonly QueuedInput[] }
  | { readonly type: 'workflow.updated'; readonly sessionId: string; readonly workflow: WorkflowSummary }
  | { readonly type: 'connection.lost'; readonly reason: string }
  | { readonly type: 'unknown'; readonly name: string; readonly payload: unknown }
