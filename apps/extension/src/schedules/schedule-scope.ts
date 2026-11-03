import path from 'node:path'
import type { ScheduleCatalogEntry, WorkspaceSummary } from '@dsh-vscode/domain'

/** Project only tasks owned by this window; Host-only path evidence never crosses the protocol. */
export function scopedSchedule(
  entry: ScheduleCatalogEntry,
  workspaces: readonly WorkspaceSummary[],
): ScheduleCatalogEntry | undefined {
  const workspace = workspaces.find((candidate) => {
    if (entry.target === undefined || entry.target.kind === 'session')
      return (
        entry.sessionId !== undefined &&
        (entry.target === undefined || entry.target.sessionId === entry.sessionId) &&
        candidate.sessionIds?.includes(entry.sessionId) === true
      )
    if (entry.sessionId !== undefined) return false
    if (entry.targetWorkingDirectory === undefined || candidate.path === undefined) return false
    const windows = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(entry.targetWorkingDirectory)
    if (windows !== /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(candidate.path)) return false
    const normalize = windows ? path.win32.normalize : path.posix.normalize
    const left = normalize(entry.targetWorkingDirectory).replace(/[\\/]+$/u, '')
    const right = normalize(candidate.path).replace(/[\\/]+$/u, '')
    return windows ? left.toLowerCase() === right.toLowerCase() : left === right
  })
  if (workspace === undefined) return undefined
  const { targetWorkingDirectory: _directory, involvedSessionIds: _sessions, ...safe } = entry
  void _directory
  void _sessions
  return entry.target === undefined ? safe : { ...safe, workspaceId: workspace.id }
}
