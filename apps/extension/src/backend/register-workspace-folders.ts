import path from 'node:path'
import type { WorkspaceCreateInput, WorkspaceSummary } from '@dsh-vscode/domain'

/** Register every missing root, while preserving the host's existing order. */
export async function registerWorkspaceFolders(
  folders: readonly string[],
  workspaces: readonly WorkspaceSummary[],
  create: (input: WorkspaceCreateInput, signal?: AbortSignal) => Promise<WorkspaceSummary>,
  samePath: (left: string, right: string) => boolean,
  trusted: boolean,
  signal?: AbortSignal,
): Promise<readonly WorkspaceSummary[]> {
  const registered = workspaces.filter(
    (workspace) =>
      workspace.path !== undefined && folders.some((folder) => samePath(workspace.path as string, folder)),
  )
  if (!trusted) return registered
  for (const folder of folders) {
    signal?.throwIfAborted()
    if (registered.some((item) => item.path !== undefined && samePath(item.path, folder))) continue
    try {
      registered.push(
        await create({ name: path.basename(path.normalize(folder)) || 'Workspace', path: folder }, signal),
      )
    } catch {
      signal?.throwIfAborted()
      // A failed registration must not hide other roots. The session filters
      // can still match this folder by cwd, and the next refresh retries it.
    }
  }
  return registered
}
