import * as vscode from 'vscode'

import {
  AppError,
  reconstructChangeBaseline,
  type ChangeDiff,
  type ChangeFileStatus,
  type EditorContextRange,
} from '@dsh-vscode/domain'
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
  private readonly baselines = new BaselineDocuments()

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
    this.assertUsable(signal)
    const editor = await this.window.showTextDocument(document, { preview: true, preserveFocus })
    this.assertUsable(signal)
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

  public async openChangeDiff(
    workspaceFolderId: string,
    relativePath: string,
    status: ChangeFileStatus,
    diffs: readonly ChangeDiff[],
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertUsable(signal)
    const resolved = this.guard.resolve(workspaceFolderId, relativePath)
    await this.guard.assertRegularFile(resolved)
    this.assertUsable(signal)
    // The open document includes unsaved edits, which is what the diff compares.
    const document = await this.workspace.openTextDocument(resolved.uri)
    this.assertUsable(signal)
    const current = document.getText()
    if (current.length > MAX_DIFF_CHARS)
      throw new AppError({
        code: 'CONTEXT_LIMIT',
        message: 'The diff is too large to open safely.',
        retryable: false,
      })
    const baseline = reconstructChangeBaseline(current, status, diffs)
    if (baseline === undefined)
      throw new AppError({
        code: 'CHANGE_INCOMPLETE',
        message: 'The file changed after this edit, so its earlier version cannot be rebuilt.',
        retryable: false,
      })
    const baselineUri = this.baselines.put(relativePath, baseline, this.workspace)
    await this.commands.executeCommand(
      'vscode.diff',
      baselineUri,
      resolved.uri,
      `${relativePath} (${BASELINE_LABEL})`,
    )
  }

  public dispose(): void {
    this.disposed = true
    this.baselines.dispose()
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

const MAX_DIFF_CHARS = 262_144
const BASELINE_SCHEME = 'jabodsh-baseline'
const BASELINE_LABEL = 'before this change'
const MAX_BASELINES = 8
const BASELINE_UNAVAILABLE =
  'This earlier version is no longer available. Use Compare in editor in the Changes list again.\n'

/** Read-only, in-memory "before" documents for the diff view; never written to disk. */
class BaselineDocuments implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>()
  private registration: vscode.Disposable | undefined
  private next = 0

  public put(relativePath: string, text: string, workspace: typeof vscode.workspace): vscode.Uri {
    this.registration ??= workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, this)
    const id = String((this.next += 1))
    this.contents.set(id, text)
    // A diff tab that is still open may ask for its content again, so only
    // versions no editor shows are dropped to keep the cache bounded.
    const open = new Set(
      (workspace.textDocuments ?? [])
        .filter((document) => document.uri.scheme === BASELINE_SCHEME)
        .map((document) => document.uri.query),
    )
    for (const candidate of [...this.contents.keys()]) {
      if (this.contents.size <= MAX_BASELINES) break
      if (candidate !== id && !open.has(candidate)) this.contents.delete(candidate)
    }
    // The path keeps the file name, so the diff gets the right language mode.
    return vscode.Uri.from({ scheme: BASELINE_SCHEME, path: `/${relativePath}`, query: id })
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    // An empty document would show the whole file as added.
    return this.contents.get(uri.query) ?? BASELINE_UNAVAILABLE
  }

  public dispose(): void {
    this.registration?.dispose()
    this.registration = undefined
    this.contents.clear()
  }
}
