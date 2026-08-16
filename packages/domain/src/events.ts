import type { WorkflowSummary } from './advanced.js'
import type { AgentConfiguration, ModelSelection, TokenUsage, ToolMode } from './models.js'
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
  readonly status: 'running' | 'stopping' | 'completed' | 'failed' | 'killed' | 'cancelled'
  readonly progress?: number
}

export interface SubagentView {
  readonly id: string
  readonly label: string
  readonly status: 'idle' | 'running' | 'awaiting-input' | 'completed' | 'failed'
  readonly parentSessionId: string
}

export interface TodoView {
  readonly id: string
  readonly content: string
  readonly status: 'pending' | 'in-progress' | 'completed'
}

export interface SessionConfigurationPatch {
  readonly preset?: AgentConfiguration['preset']
  readonly toolMode?: ToolMode
  readonly permissionPreset?: AgentConfiguration['permissionPreset']
  readonly planMode?: boolean
  readonly sandboxMode?: string
  readonly approvalPolicy?: string
  readonly model?: Partial<ModelSelection>
}

export interface CompactionView {
  readonly id: string
  readonly phase: 'start' | 'summary' | 'prune' | 'end'
  readonly summary?: string
}

type BackendEventPayload =
  | { readonly type: 'session.status'; readonly sessionId: string; readonly status: string }
  | { readonly type: 'session.title'; readonly sessionId: string; readonly title: string }
  | {
      readonly type: 'session.configuration'
      readonly sessionId: string
      readonly patch: SessionConfigurationPatch
    }
  | { readonly type: 'session.added'; readonly sessionId: string; readonly blank?: boolean }
  | { readonly type: 'session.removed'; readonly sessionId: string }
  | {
      readonly type: 'message.user'
      readonly sessionId: string
      readonly messageId: string
      readonly markdown: string
      readonly rpcId?: string
      readonly source?: string
      readonly sourceForm?: string
      readonly sourceSummary?: string
    }
  | {
      readonly type: 'message.delta'
      readonly sessionId: string
      readonly messageId: string
      readonly delta: string
    }
  | {
      readonly type: 'reasoning.delta'
      readonly sessionId: string
      readonly messageId: string
      readonly delta: string
    }
  | {
      readonly type: 'message.completed'
      readonly sessionId: string
      readonly messageId: string
      readonly markdown?: string
      readonly reasoning?: string
      readonly modelLabel?: string
      readonly usage?: TokenUsage
    }
  | { readonly type: 'tool.updated'; readonly sessionId: string; readonly tool: ToolCallView }
  | { readonly type: 'permission.requested'; readonly request: PermissionRequest }
  | { readonly type: 'question.requested'; readonly question: UserQuestion }
  | {
      readonly type: 'permission.resolved'
      readonly sessionId: string
      readonly requestId: string
      readonly outcome?: string
    }
  | {
      readonly type: 'question.resolved'
      readonly sessionId: string
      readonly questionRpcId?: string
      readonly questionId?: string
      readonly outcome?: string
    }
  | { readonly type: 'goal.updated'; readonly sessionId: string; readonly goals: readonly GoalView[] }
  | { readonly type: 'todo.updated'; readonly sessionId: string; readonly todos: readonly TodoView[] }
  | {
      readonly type: 'compaction.updated'
      readonly sessionId: string
      readonly compaction: CompactionView
    }
  | { readonly type: 'job.updated'; readonly sessionId: string; readonly job: JobView }
  | { readonly type: 'jobs.updated'; readonly sessionId: string; readonly jobs: readonly JobView[] }
  | { readonly type: 'subagent.updated'; readonly sessionId: string; readonly subagent: SubagentView }
  | { readonly type: 'queue.updated'; readonly sessionId: string; readonly items: readonly QueuedInput[] }
  | { readonly type: 'workflow.updated'; readonly sessionId: string; readonly workflow: WorkflowSummary }
  | { readonly type: 'session.subscribed'; readonly sessionId: string; readonly lastSequence: number }
  | {
      readonly type: 'session.projection'
      readonly sessionId: string
      readonly key: string
      readonly value: unknown
    }
  | {
      readonly type: 'session.gap'
      readonly sessionId: string
      readonly fromSequence: number
      readonly toSequence: number
    }
  | { readonly type: 'workspace.changed'; readonly workspaceId?: string }
  | { readonly type: 'workspace.removed'; readonly workspaceId?: string }
  | { readonly type: 'workspace.order.changed'; readonly workspaceIds: readonly string[] }
  | { readonly type: 'archived.sessions.changed'; readonly sessionIds: readonly string[] }
  | { readonly type: 'remote.event'; readonly name: string; readonly args: readonly unknown[] }
  | { readonly type: 'connection.lost'; readonly reason: string }
  | {
      readonly type: 'notice'
      readonly sessionId?: string
      readonly level: 'info' | 'warning' | 'error'
      readonly text: string
    }
  | {
      readonly type: 'unknown'
      readonly sessionId?: string
      readonly name: string
      readonly payload: unknown
    }

/** Transport sequence metadata is optional for host-level notices but is
 * mandatory at runtime for sequenced session frames. Keeping it outside the
 * payload union lets older consumers continue handling the same event kinds. */
export type BackendEvent = BackendEventPayload & { readonly sequence?: number }
