import type { SessionSummary, WorkspaceSummary } from '@dsh-vscode/domain'

export type SessionDirectoryStatus = 'loading' | 'ready' | 'error'

export type ScheduleSessionLink =
  | { readonly status: 'available'; readonly title: string }
  | { readonly status: 'loading' | 'error' | 'archived' | 'missing' }

/** Resolve a schedule's original Session only from a complete, current roster. */
export function resolveScheduleSessionLink(
  sessionId: string,
  directoryStatus: SessionDirectoryStatus,
  sessions: readonly SessionSummary[],
  workspaces: readonly WorkspaceSummary[],
  archivedSessionIds: readonly string[],
): ScheduleSessionLink {
  if (directoryStatus === 'loading') return { status: 'loading' }
  if (directoryStatus === 'error') return { status: 'error' }
  if (archivedSessionIds.includes(sessionId)) return { status: 'archived' }

  const session = sessions.find((candidate) => candidate.id === sessionId)
  if (session === undefined) return { status: 'missing' }

  const workspace = workspaces.find((candidate) => candidate.id === session.workspaceId)
  if (
    workspace === undefined ||
    (workspace.sessionIds !== undefined && !workspace.sessionIds.includes(sessionId))
  )
    return { status: 'missing' }

  const title = session.title.trim()
  return { status: 'available', title: title === '' ? session.id : title }
}
