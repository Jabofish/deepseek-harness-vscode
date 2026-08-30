import type { TaskControlAction, TaskOwnerKind, TaskCenterTaskStatus } from './task-center-spike.js'

export type TaskSummaryKind = 'session' | 'subagent' | 'job' | 'goal' | 'interaction' | 'unknown'
export type TaskSummaryStatus = TaskCenterTaskStatus
export type TaskControlMode = TaskControlAction
export type TaskSummaryOwnerKind = TaskOwnerKind
export type TaskActionKind = 'approval' | 'question' | 'configuration' | 'none'

/** Safe, read-only task projection exposed to the Webview. */
export interface TaskSummary {
  readonly taskId: string
  readonly sourceId: string
  readonly sessionId?: string
  readonly parentTaskId?: string
  readonly workspaceFolderId: string
  readonly kind: TaskSummaryKind
  readonly title: string
  readonly status: TaskSummaryStatus
  readonly needsUserAction: boolean
  readonly actionKind?: TaskActionKind
  readonly interactionId?: string
  readonly modelLabel?: string
  readonly providerLabel?: string
  readonly startedAt: number
  readonly updatedAt: number
  readonly progress?: number
  readonly childCount: number
  readonly canOpen: boolean
  readonly canAnswer: boolean
  readonly canSessionCancel: boolean
  readonly canProcessStop: boolean
  readonly ownerKind: TaskSummaryOwnerKind
  readonly backendInstanceId?: string
  readonly connectionGeneration?: number
  readonly taskRevision: number
}

export interface TaskListQuery {
  readonly workspaceFolderId?: string
  readonly sessionId?: string
  readonly includeCompleted?: boolean
  readonly cursor?: string
  readonly limit?: number
}

export interface TaskRepository {
  list(query?: TaskListQuery, signal?: AbortSignal): Promise<readonly TaskSummary[]>
  get(taskId: string, signal?: AbortSignal): Promise<TaskSummary>
  stop(
    taskId: string,
    mode: TaskControlMode,
    taskRevision: number,
    signal?: AbortSignal,
  ): Promise<TaskSummary>
  answer(taskId: string, interactionId: string, answer: string, signal?: AbortSignal): Promise<TaskSummary>
}

export function isTaskTerminal(status: TaskSummaryStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'disconnected'
}
