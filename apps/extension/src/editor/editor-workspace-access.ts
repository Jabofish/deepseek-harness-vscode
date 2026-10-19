import * as vscode from 'vscode'
import { EditorCompanionError } from '@dsh-vscode/domain'

/** Ask only when a tool actually needs access; never grant workspace trust ourselves. */
export class EditorWorkspaceAccess {
  private pending: Promise<void> | undefined
  private dismissed = false

  public constructor(private readonly enabled: () => boolean) {}

  public reason(): 'workspace' | 'untrusted' | undefined {
    if (!vscode.workspace.isTrusted) return 'untrusted'
    return this.folders().length === 0 ? 'workspace' : undefined
  }

  public folders(): readonly vscode.WorkspaceFolder[] {
    return (vscode.workspace.workspaceFolders ?? []).filter(
      (folder) =>
        folder.uri.scheme === 'file' ||
        (folder.uri.scheme === 'vscode-remote' && vscode.env.remoteName !== undefined),
    )
  }

  public reset(): void {
    this.dismissed = false
  }

  public async request(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const reason = this.reason()
    if (reason === undefined) return
    if (this.pending === undefined && !this.dismissed && this.enabled()) {
      this.dismissed = true
      const operation = this.prompt(reason).finally(() => {
        if (this.pending === operation) this.pending = undefined
      })
      this.pending = operation
    }
    let abort: (() => void) | undefined
    try {
      await Promise.race([
        this.pending,
        new Promise<void>((_resolve, reject) => {
          abort = () => reject(new EditorCompanionError('cancelled'))
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        }),
      ])
    } finally {
      if (abort !== undefined) signal.removeEventListener('abort', abort)
    }
    signal.throwIfAborted()
    const blocked = this.reason()
    if (blocked !== undefined)
      throw new EditorCompanionError(blocked === 'untrusted' ? 'untrusted' : 'workspace-mismatch')
  }

  private async prompt(reason: 'workspace' | 'untrusted'): Promise<void> {
    const action = reason === 'untrusted' ? 'Manage Workspace Trust' : 'Choose Folder'
    const choice = await vscode.window.showInformationMessage(
      reason === 'untrusted'
        ? 'DSH requested editor access. Trust this VS Code workspace to allow it.'
        : 'DSH requested editor access. Choose a folder to use in this VS Code window.',
      action,
    )
    if (choice !== action || !this.enabled() || this.reason() !== reason) return
    await vscode.commands.executeCommand(
      reason === 'untrusted' ? 'workbench.trust.manage' : 'workbench.action.addRootFolder',
    )
  }
}
