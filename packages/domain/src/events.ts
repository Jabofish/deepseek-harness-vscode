import type { WorkflowSummary } from './advanced.js'
import type { AgentConfiguration, ModelSelection, TokenUsage, ToolMode } from './models.js'
import type { PromptAttachment, QueuedInput } from './sessions.js'
import type { PermissionRequest, ToolCallView, UserQuestion } from './tools.js'

export interface GoalView {
  readonly id: string
  readonly title: string
  readonly status: 'pending' | 'in-progress' | 'completed' | 'blocked'
}

export interface JobView {
  readonly id: string
  /** Registry-issued `<kind>-N` producer kind; bare string because producers extend the set. */
  readonly kind: string
  readonly label: string
  readonly status: 'running' | 'stopping' | 'completed' | 'failed' | 'killed'
  /** Kind-specific status detail ('exit code: 3'), once the producer supplied one. */
  readonly detail?: string
  /** Epoch ms marks the row's duration; live rows tick against the clock. */
  readonly startedAt: number
  readonly finishedAt?: number
}

export interface SubagentView {
  readonly kind: 'child'
  readonly id: string
  readonly label?: string
  readonly activity: 'running' | 'inactive'
  readonly parentSessionId: string
  /** Delegation mode; only continuable children accept follow-up prompts. */
  readonly mode: 'one-shot' | 'continuable'
  /** Whether the catalog knows this child to have children of its own. */
  readonly hasChildren: boolean
}

export interface SubagentDiagnosticView {
  readonly kind: 'diagnostic'
  readonly id: string
  readonly parentSessionId: string
  readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
}

export interface SubagentCatalog {
  readonly entries: readonly (SubagentView | SubagentDiagnosticView)[]
  readonly parentAvailable: boolean
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
  readonly replacedCount?: number
  readonly estimatedTokens?: number
}

export type TeamMemberPhase = 'provisioning' | 'active' | 'failed'
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/** Safe, read-only projection of the experimental rc.8 Agent Teams events. */
export type TeamActivityView =
  | {
      readonly kind: 'member'
      readonly id: string
      readonly teamId: string
      readonly memberId: string
      readonly name: string
      readonly phase: TeamMemberPhase
      readonly error?: string
    }
  | {
      readonly kind: 'task'
      readonly id: string
      readonly teamId: string
      readonly taskId: string
      readonly subject: string
      readonly status: TeamTaskStatus
      readonly ownerId?: string
      readonly blockedByCount: number
      readonly writeScopeCount: number
    }
  | {
      readonly kind: 'message.queued' | 'message.delivered'
      readonly id: string
      readonly teamId: string
      readonly messageId: string
      readonly senderName?: string
      readonly targetId: string
      readonly delivery?: 'quiet' | 'wakeup'
      readonly content?: string
    }

/**
 * Structured model-retry signal. The official Web UI aggregates consecutive
 * retries into one silent status row with a countdown instead of surfacing
 * each retry as a separate warning.
 */
export interface ModelRetrySignal {
  readonly sessionId: string
  /** Producer-owned identity shared by one retry chain. */
  readonly id: string
  readonly turn: number
  readonly step: number
  readonly attempt: number
  readonly state: 'scheduled' | 'started'
  readonly delayMs?: number
  readonly maxRetries?: number
  readonly message?: string
}

/** Safe, presentation-only metadata for a file represented in a user turn. */
export type MessageAttachment = Pick<PromptAttachment, 'name' | 'mimeType'>

/** Durable image reference used by the upstream conversation image surface. */
export type MessageImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export interface MessageImageReference {
  readonly attachmentId: string
  readonly mediaType: MessageImageMediaType
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** Terminal boundary reported by the durable DSH turn lifecycle. */
export type TurnEndReasonKind =
  'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted' | 'unknown'

type BackendEventPayload =
  | { readonly type: 'session.status'; readonly sessionId: string; readonly status: string }
  | { readonly type: 'session.title'; readonly sessionId: string; readonly title: string }
  | {
      readonly type: 'session.configuration'
      readonly sessionId: string
      readonly patch: SessionConfigurationPatch
    }
  | { readonly type: 'turn.started'; readonly sessionId: string; readonly turn: number }
  | {
      readonly type: 'turn.ended'
      readonly sessionId: string
      readonly turn: number
      readonly reason: TurnEndReasonKind
    }
  | {
      readonly type: 'session.added'
      readonly sessionId: string
      readonly blank?: boolean
      readonly parentSessionId?: string
      readonly origin?: 'subagent'
      /** Session working directory from the Host creation increment. */
      readonly cwd?: string
      /** Resolved agent preset used to compose the new session. */
      readonly agentPreset?: string
    }
  | { readonly type: 'session.removed'; readonly sessionId: string }
  | {
      readonly type: 'message.user'
      readonly sessionId: string
      readonly messageId: string
      readonly markdown: string
      readonly attachments?: readonly MessageAttachment[]
      readonly images?: readonly MessageImageReference[]
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
      readonly turn?: number
      readonly step?: number
      /** Epoch milliseconds from the durable DSH event. */
      readonly time?: number
    }
  | {
      readonly type: 'reasoning.delta'
      readonly sessionId: string
      readonly messageId: string
      readonly delta: string
      readonly turn?: number
      readonly step?: number
      /** Epoch milliseconds from the durable DSH event. */
      readonly time?: number
    }
  | {
      readonly type: 'message.completed'
      readonly sessionId: string
      readonly messageId: string
      readonly markdown?: string
      readonly reasoning?: string
      readonly modelLabel?: string
      readonly images?: readonly MessageImageReference[]
      readonly usage?: TokenUsage
      readonly turn?: number
      readonly step?: number
      /** Epoch milliseconds from the durable DSH event. */
      readonly time?: number
      /** rc.8 finalizes a delivered prefix when cancellation interrupts a step. */
      readonly interrupted?: true
    }
  | {
      /** DSH `step/start`; opens the assistant timing boundary. */
      readonly type: 'step.started'
      readonly sessionId: string
      readonly turn: number
      readonly step: number
      /** Epoch milliseconds from the durable DSH event. */
      readonly time?: number
    }
  | {
      /** DSH `step/end`; closes an interrupted timing boundary. */
      readonly type: 'step.ended'
      readonly sessionId: string
      readonly turn: number
      readonly step: number
      /** Epoch milliseconds from the durable DSH event. */
      readonly time?: number
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
  | { readonly type: 'model.retry'; readonly retry: ModelRetrySignal }
  | { readonly type: 'jobs.updated'; readonly sessionId: string; readonly jobs: readonly JobView[] }
  | { readonly type: 'queue.updated'; readonly sessionId: string; readonly items: readonly QueuedInput[] }
  | { readonly type: 'workflow.started'; readonly sessionId: string; readonly workflow: WorkflowSummary }
  | {
      readonly type: 'workflow.member.started'
      readonly sessionId: string
      readonly runId: string
      readonly phase: string | null
      readonly member: WorkflowSummary['stages'][number]['members'][number]
    }
  | {
      readonly type: 'workflow.member.ended'
      readonly sessionId: string
      readonly runId: string
      readonly seq: number
      readonly outcome: 'completed' | 'failed' | 'cancelled'
    }
  | {
      readonly type: 'workflow.ended'
      readonly sessionId: string
      readonly runId: string
      readonly stopReason: 'completed' | 'cancelled' | 'error'
    }
  | { readonly type: 'team.updated'; readonly sessionId: string; readonly activity: TeamActivityView }
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
      /** Structured `/command` input from a DSH command/run lifecycle. */
      readonly commandInput?: string
      /** Structured command name; keeps control-plane filtering out of text parsing. */
      readonly commandName?: string
      /** DSH command lifecycle identity shared by command/run and command/done. */
      readonly commandId?: string
      readonly commandPhase?: 'run' | 'done'
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
