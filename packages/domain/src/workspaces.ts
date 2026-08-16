export interface WorkspaceSummary {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly sessionCount: number
}

export interface WorkspaceCreateInput {
  readonly name: string
  readonly path: string
}
