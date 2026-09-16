import * as vscode from 'vscode'

import { AppError, type EditorContextRange } from '@dsh-vscode/domain'
import type { NavigationPort } from '@dsh-vscode/application'

import { WorkspacePathGuard } from '../editor/workspace-path-guard.js'

export interface NavigationServiceOptions {
  readonly workspace?: typeof vscode.workspace
  readonly window?: typeof vscode.window
  readonly commands?: typeof vscode.commands
}

/** Host-only navigation; callers can provide only a workspace id and relative path. */
export class NavigationService implements NavigationPort, vscode.Disposable {
  private readonly workspace: typeof vscode.workspace
  private readonly window: typeof vscode.window
  private readonly commands: typeof vscode.commands
  private readonly guard: WorkspacePathGuard
  private disposed = false

  public constructor(options: NavigationServiceOptions = {}) {
    this.workspace = options.workspace ?? vscode.workspace
    this.window = options.window ?? vscode.window
    this.commands = options.commands ?? vscode.commands
    this.guard = new WorkspacePathGuard(this.workspace)
  }

  public async openFile(
    workspaceFolderId: string,
    relativePath: string,
    range?: EditorContextRange,
    signal?: AbortSignal,
    preserveFocus = false,
  ): Promise<void> {
    this.assertUsable(signal)
    const resolved = this.guard.resolve(workspaceFolderId, relativePath)
    await this.guard.assertRegularFile(resolved)
    this.assertUsable(signal)
    const document = await this.workspace.openTextDocument(resolved.uri)
    const editor = await this.window.showTextDocument(document, { preview: true, preserveFocus })
    if (range !== undefined) {
      const vscodeRange = this.guard.clampRange(document, range)
      editor.selection = new vscode.Selection(vscodeRange.start, vscodeRange.end)
      editor.revealRange(vscodeRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    }
  }

  public async revealLine(
    workspaceFolderId: string,
    relativePath: string,
    line: number,
    column?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.openFile(
      workspaceFolderId,
      relativePath,
      {
        start: { line, column: column ?? 0 },
        end: { line, column: column ?? 0 },
      },
      signal,
    )
  }

  public async showInExplorer(
    workspaceFolderId: string,
    relativePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertUsable(signal)
    const resolved = this.guard.resolve(workspaceFolderId, relativePath)
    await this.guard.assertRegularFile(resolved)
    this.assertUsable(signal)
    await this.commands.executeCommand('revealInExplorer', resolved.uri)
  }

  public async openDiff(
    workspaceFolderId: string,
    relativePath: string,
    before: string,
    after?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertUsable(signal)
    const resolved = this.guard.resolve(workspaceFolderId, relativePath)
    await this.guard.assertRegularFile(resolved)
    if (before.length > 262_144 || (after?.length ?? 0) > 262_144)
      throw new AppError({
        code: 'CONTEXT_LIMIT',
        message: 'The diff is too large to open safely.',
        retryable: false,
      })
    // The feature route currently uses this only for Host-produced, bounded
    // text. A future implementation should provide a dedicated content
    // provider instead of writing a user-visible temporary file.
    await this.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.parse(`data:text/plain,${encodeURIComponent(before)}`),
      resolved.uri,
      relativePath,
    )
  }

  public dispose(): void {
    this.disposed = true
  }

  private assertUsable(signal?: AbortSignal): void {
    if (this.disposed)
      throw new AppError({
        code: 'REQUEST_CANCELLED',
        message: 'Navigation has been disposed.',
        retryable: true,
      })
    if (signal?.aborted === true)
      throw new AppError({ code: 'REQUEST_CANCELLED', message: 'Navigation was cancelled.', retryable: true })
  }
}
