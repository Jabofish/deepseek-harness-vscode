import type { SessionListQuery, SessionPage, WorkspaceSummary } from '@dsh-vscode/domain'
import type { RequestGatewayDependencies } from './request-gateway-dependencies.js'
import { sameWorkspacePath } from './workspace-state.js'

export type DirectoryDependencies = Pick<
  RequestGatewayDependencies,
  'currentWorkspaceFolders' | 'listCurrentWorkspaces' | 'listCurrentArchivedSessionIds'
> & { readonly sessionUseCases: Pick<RequestGatewayDependencies['sessionUseCases'], 'list'> }

/** Both session lists use the same DSH summaries and workspace/archive boundary. */
export async function listScopedSessions(
  deps: DirectoryDependencies,
  query: SessionListQuery,
  signal: AbortSignal,
  currentWorkspaces?: readonly WorkspaceSummary[],
): Promise<SessionPage> {
  signal.throwIfAborted()
  const folders = deps.currentWorkspaceFolders()
  const workspaces = currentWorkspaces ?? (await deps.listCurrentWorkspaces(signal))
  signal.throwIfAborted()
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id))
  const sessionIds = new Set(workspaces.flatMap((workspace) => workspace.sessionIds ?? []))
  const workspaceId = query.workspaceId
  const archived = query.archived ?? false
  if (workspaceId !== undefined && !workspaceIds.has(workspaceId)) return { items: [] }
  const [archive, page] = await Promise.all([
    deps.listCurrentArchivedSessionIds(workspaces, signal),
    deps.sessionUseCases.list({ ...query, archived }, signal),
  ])
  signal.throwIfAborted()
  const archivedIds = new Set(archive)
  return {
    ...page,
    items: page.items.filter((session) => {
      const belongs =
        (workspaceId === undefined
          ? workspaceIds.has(session.workspaceId)
          : session.workspaceId === workspaceId) || sessionIds.has(session.id)
      const cwd = session.cwd
      return (
        (belongs ||
          (cwd !== undefined && folders.some((folder) => sameWorkspacePath(cwd, folder.uri.fsPath)))) &&
        archivedIds.has(session.id) === archived
      )
    }),
  }
}
