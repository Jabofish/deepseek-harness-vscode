import { realpath } from 'node:fs/promises'
import * as vscode from 'vscode'
import {
  EditorBridgeError,
  isEditorStateSnapshot,
  type EditorStateSnapshot,
  type EditorStatePort,
} from '@dsh-vscode/domain'
import { isPathWithin } from '../backend/path-safety.js'
import { WorkspacePathGuard, workspaceFolderId } from './workspace-path-guard.js'

/** Only metadata crosses the bridge; diagnostic messages and document text are never read. */
export class EditorStateProvider implements EditorStatePort {
  public constructor(
    private readonly folderId: string,
    private readonly isCurrent: () => boolean,
  ) {}

  public async read(signal: AbortSignal): Promise<EditorStateSnapshot> {
    signal.throwIfAborted()
    if (!vscode.workspace.isTrusted) throw new EditorBridgeError('untrusted')
    if (!this.isCurrent() || vscode.workspace.workspaceFolders?.length !== 1)
      throw new EditorBridgeError('workspace-mismatch')
    const editor = vscode.window.activeTextEditor
    if (editor === undefined || editor.document.uri.scheme !== 'file')
      throw new EditorBridgeError('no-editor')
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri)
    if (folder === undefined || workspaceFolderId(folder) !== this.folderId)
      throw new EditorBridgeError('workspace-mismatch')
    const guard = new WorkspacePathGuard()
    let relativePath: string
    let rootPath: string
    let filePath: string
    try {
      relativePath = guard.relativePath(folder, editor.document.uri)
      const resolved = guard.resolve(this.folderId, relativePath)
      await guard.assertRegularFile(resolved)
      ;[rootPath, filePath] = await Promise.all([
        realpath(folder.uri.fsPath),
        realpath(editor.document.uri.fsPath),
      ])
    } catch {
      signal.throwIfAborted()
      throw new EditorBridgeError('workspace-mismatch')
    }
    signal.throwIfAborted()
    if (!isPathWithin(rootPath, filePath)) throw new EditorBridgeError('workspace-mismatch')
    if (!vscode.workspace.isTrusted) throw new EditorBridgeError('untrusted')
    if (
      !this.isCurrent() ||
      vscode.window.activeTextEditor !== editor ||
      vscode.workspace.workspaceFolders?.length !== 1 ||
      vscode.workspace.workspaceFolders[0] !== folder
    )
      throw new EditorBridgeError('workspace-mismatch')
    // All VS Code properties below are sampled synchronously after the asynchronous guards.
    let errors = 0
    let warnings = 0
    for (const diagnostic of vscode.languages.getDiagnostics(editor.document.uri)) {
      if (diagnostic.severity === vscode.DiagnosticSeverity.Error) errors += 1
      if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) warnings += 1
    }
    const { start, end } = editor.selection
    const snapshot: EditorStateSnapshot = {
      relativePath,
      languageId: editor.document.languageId,
      documentVersion: editor.document.version,
      dirty: editor.document.isDirty,
      selection: {
        start: { line: start.line + 1, column: start.character + 1 },
        end: { line: end.line + 1, column: end.character + 1 },
      },
      diagnostics: { errors, warnings },
      capturedAt: new Date().toISOString(),
    }
    if (!isEditorStateSnapshot(snapshot)) throw new EditorBridgeError('invalid-response')
    return snapshot
  }
}
