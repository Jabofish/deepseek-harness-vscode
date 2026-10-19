import { realpath } from 'node:fs/promises'
import path from 'node:path'
import * as vscode from 'vscode'
import { EditorCompanionError, isCanonicalWorkspaceRelativePath, type EditorRange } from '@dsh-vscode/domain'
import { isPathWithin } from '../backend/path-safety.js'

/** One granted root, resolved in the workspace Extension Host's own filesystem. */
export class CompanionWorkspace {
  public constructor(
    public readonly folder: vscode.WorkspaceFolder,
    private readonly current: () => boolean,
  ) {}
  public assert(signal: AbortSignal): void {
    signal.throwIfAborted()
    if (!vscode.workspace.isTrusted) throw new EditorCompanionError('untrusted')
    if (!this.current() || !vscode.workspace.workspaceFolders?.includes(this.folder))
      throw new EditorCompanionError('workspace-mismatch')
    if (
      this.folder.uri.scheme !== 'file' &&
      !(this.folder.uri.scheme === 'vscode-remote' && vscode.env.remoteName !== undefined)
    )
      throw new EditorCompanionError('unsupported')
  }
  public relative(uri: vscode.Uri): string {
    if (
      uri.scheme !== this.folder.uri.scheme ||
      uri.authority !== this.folder.uri.authority ||
      !isPathWithin(this.folder.uri.fsPath, uri.fsPath)
    )
      throw new EditorCompanionError('workspace-mismatch')
    const relative = path.relative(this.folder.uri.fsPath, uri.fsPath).split(path.sep).join('/')
    if (!isCanonicalWorkspaceRelativePath(relative)) throw new EditorCompanionError('workspace-mismatch')
    return relative
  }
  public async validate(uri: vscode.Uri, signal: AbortSignal): Promise<string> {
    this.assert(signal)
    const relative = this.relative(uri)
    try {
      const [root, file, stat] = await Promise.all([
        realpath(this.folder.uri.fsPath),
        realpath(uri.fsPath),
        vscode.workspace.fs.stat(uri),
      ])
      if (
        !isPathWithin(root, file) ||
        (stat.type & vscode.FileType.File) === 0 ||
        (stat.type & vscode.FileType.SymbolicLink) !== 0
      )
        throw new EditorCompanionError('workspace-mismatch')
      if (stat.size > 2_097_152) throw new EditorCompanionError('limit')
    } catch (error) {
      if (error instanceof EditorCompanionError) throw error
      throw new EditorCompanionError('workspace-mismatch')
    }
    this.assert(signal)
    return relative
  }
  public async document(relativePath: string | undefined, signal: AbortSignal): Promise<vscode.TextDocument> {
    this.assert(signal)
    let uri: vscode.Uri
    if (relativePath === undefined) {
      const editor = vscode.window.activeTextEditor
      if (editor === undefined) throw new EditorCompanionError('no-editor')
      uri = editor.document.uri
    } else {
      if (!isCanonicalWorkspaceRelativePath(relativePath))
        throw new EditorCompanionError('workspace-mismatch')
      uri = vscode.Uri.joinPath(this.folder.uri, ...relativePath.split('/'))
    }
    await this.validate(uri, signal)
    const document =
      vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString()) ??
      (await vscode.workspace.openTextDocument(uri))
    await this.validate(document.uri, signal)
    this.assert(signal)
    if (document.isClosed) throw new EditorCompanionError('unavailable')
    return document
  }
  public range(document: vscode.TextDocument, range: EditorRange): vscode.Range {
    const valid = (position: EditorRange['start']): boolean =>
      position.line >= 1 &&
      position.line <= document.lineCount &&
      position.column >= 1 &&
      position.column <= document.lineAt(position.line - 1).text.length + 1
    if (!valid(range.start) || !valid(range.end)) throw new EditorCompanionError('stale-document')
    return new vscode.Range(
      range.start.line - 1,
      range.start.column - 1,
      range.end.line - 1,
      range.end.column - 1,
    )
  }
}
export function companionRange(range: vscode.Range): EditorRange {
  return {
    start: { line: range.start.line + 1, column: range.start.character + 1 },
    end: { line: range.end.line + 1, column: range.end.character + 1 },
  }
}
