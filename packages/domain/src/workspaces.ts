export interface WorkspaceSummary {
  readonly id: string
  readonly name: string
  readonly path?: string
  /** Session membership is used to scope summaries when rc.6 omits workspaceId. */
  readonly sessionIds?: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly sessionCount: number
}

export interface WorkspaceCreateInput {
  readonly name: string
  readonly path: string
}
