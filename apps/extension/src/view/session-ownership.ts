/**
 * Workspace ownership of a session id, following the durable parent chain the
 * subagent catalog published.
 *
 * A catalog-resolved child session has no workspace membership of its own —
 * `session/list` drops a child without a cwd — so its ownership comes from the
 * parent it was delegated from. Only the host catalog knows that link, and the
 * Session Controller refuses to re-derive it from an ordinary session read.
 */
export interface SessionOwnershipInput {
  readonly sessionId: string
  /** The already-read detail of `sessionId`. */
  readonly detail: { readonly id: string; readonly workspaceId: string; readonly cwd?: string }
  /** True when a session belongs to the current VS Code workspace. */
  readonly belongs: (session: {
    readonly id: string
    readonly workspaceId: string
    readonly cwd?: string
  }) => boolean
  /** Durable parent of a catalog-resolved child, if the catalog knows one. */
  readonly parentOf: (childSessionId: string) => string | undefined
  /** Read one session through the ordinary repository. */
  readonly readSession: (
    sessionId: string,
  ) => Promise<{ readonly id: string; readonly workspaceId: string; readonly cwd?: string }>
}

export async function ownsCurrentWorkspaceSession(input: SessionOwnershipInput): Promise<boolean> {
  if (input.belongs(input.detail)) return true
  // The host cannot produce a cycle, but a self-parent or a repeated id would
  // otherwise walk forever inside a route handler.
  const visited = new Set<string>([input.sessionId])
  let parentId = input.parentOf(input.sessionId)
  while (parentId !== undefined && !visited.has(parentId)) {
    visited.add(parentId)
    const parent = await input.readSession(parentId)
    if (input.belongs(parent)) return true
    parentId = input.parentOf(parentId)
  }
  return false
}
