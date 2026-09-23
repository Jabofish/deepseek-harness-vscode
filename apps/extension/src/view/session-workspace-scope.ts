import type { SessionSummary } from '@dsh-vscode/domain'

export interface SessionWorkspaceFolder {
  readonly id: string
  readonly path: string
}

export interface SessionWorkspaceScopeInput {
  /** The folders VS Code currently owns, in `workspace.list` order. */
  readonly folders: readonly SessionWorkspaceFolder[]
  readonly session: Pick<SessionSummary, 'cwd'>
  readonly samePath: (left: string, right: string) => boolean
}

/**
 * Resolve the VS Code workspace folder that guards a session's paths.
 *
 * The session cwd is authoritative when it names an open folder. A DSH
 * workspace id is a different namespace and never answers this question, and a
 * folder no longer open in VS Code is not a root: an unresolved session stays
 * unscoped so its folder-scoped surfaces are reported as unavailable instead
 * of failing against a root the Host does not own.
 */
export function sessionWorkspaceFolderId(input: SessionWorkspaceScopeInput): string | undefined {
  const { folders, session } = input
  if (folders.length === 0) return undefined
  if (session.cwd !== undefined) {
    const cwdFolder = folders.find((folder) => input.samePath(folder.path, session.cwd as string))
    if (cwdFolder !== undefined) return cwdFolder.id
  }
  // One folder open is the whole workspace; several folders and no matching
  // cwd leave the session ambiguous.
  return folders.length === 1 ? folders[0]?.id : undefined
}
