import type * as vscode from 'vscode'
import type { WorkspaceSummary } from '@dsh-vscode/domain'
import type { WebviewRequest } from '@dsh-vscode/webview-protocol'
import { sameWorkspacePath } from './workspace-state.js'

export function sessionBelongsToWorkspaces(
  session: { readonly id: string; readonly workspaceId: string; readonly cwd?: string },
  workspaces: readonly WorkspaceSummary[],
  folders: readonly vscode.WorkspaceFolder[] = [],
): boolean {
  return (
    workspaces.some(
      (workspace) =>
        session.workspaceId === workspace.id ||
        workspace.sessionIds?.includes(session.id) === true ||
        (workspace.path !== undefined &&
          session.cwd !== undefined &&
          sameWorkspacePath(workspace.path, session.cwd)),
    ) ||
    (session.cwd !== undefined &&
      folders.some((folder) => sameWorkspacePath(session.cwd as string, folder.uri.fsPath)))
  )
}
export function requiresTrustedWorkspace(type: WebviewRequest['type']): boolean {
  switch (type) {
    case 'workspace.rename':
    case 'workspace.remove':
    case 'workspace.move':
    case 'session.move':
    case 'session.create':
    case 'session.rename':
    case 'session.remove':
    case 'session.fork':
    case 'session.archive':
    case 'session.open':
    case 'session.history':
    case 'session.sendPrompt':
    case 'session.queue.list':
    case 'session.queue.update':
    case 'session.queue.remove':
    case 'session.queue.steer':
    case 'session.cancel':
    case 'session.configure':
    case 'attachment.pick':
    case 'attachment.ingest':
    case 'attachment.preview':
    case 'attachment.open.list':
    case 'attachment.open.attach':
    case 'attachment.read':
    case 'reference.list':
    case 'feedback.list':
    case 'feedback.toggle':
    case 'feedback.note':
    case 'feedback.remove':
    case 'models.discover.custom':
    case 'provider.secret.configure':
    case 'provider.secret.remove':
    case 'provider.custom.create':
    case 'plugin.credential.configure':
    case 'plugin.credential.remove':
    case 'interaction.permission.respond':
    case 'interaction.question.respond':
    case 'interaction.question.cancel':
    case 'settings.update':
    case 'settings.unset':
    case 'settings.mutate':
    case 'settings.openDocument':
    case 'settings.openKeyboardShortcuts':
    case 'goal.list':
    case 'goal.update':
    case 'goal.clear':
    case 'subagent.send':
    case 'subagent.interrupt':
    case 'subagent.list':
    case 'subagent.history':
    case 'skill.list':
    case 'skill.openDocument':
    case 'command.list':
    case 'command.execute':
    case 'job.list':
    case 'job.kill':
    case 'job.follow.start':
    case 'job.follow.stop':
    case 'preset.read':
    case 'preset.copy':
    case 'preset.openDocument':
    case 'preset.remove':
    case 'session.export':
      return true
    default:
      return false
  }
}
