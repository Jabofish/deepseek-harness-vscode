import { createHash } from 'node:crypto'
import path from 'node:path'
import * as vscode from 'vscode'

import {
  AppError,
  isCanonicalWorkspaceRelativePath,
  isValidEditorContextRange,
  type EditorContextPosition,
  type EditorContextRange,
} from '@dsh-vscode/domain'

import { isPathWithin } from '../backend/path-safety.js'

export interface ResolvedWorkspacePath {
  readonly workspaceFolder: vscode.WorkspaceFolder
  readonly uri: vscode.Uri
  readonly relativePath: string
}

export function workspaceFolderId(folder: vscode.WorkspaceFolder): string {
  return `workspace:${createHash('sha256').update(folder.uri.fsPath).digest('hex').slice(0, 24)}`
}

export class WorkspacePathGuard {
  public constructor(private readonly workspace: typeof vscode.workspace = vscode.workspace) {}

  public resolve(workspaceId: string, relativePath: string): ResolvedWorkspacePath {
    if (!isCanonicalWorkspaceRelativePath(relativePath)) throw pathNotAllowed()
    const folder = this.workspace.workspaceFolders?.find(
      (candidate) => workspaceFolderId(candidate) === workspaceId,
    )
    if (folder === undefined) throw pathNotAllowed()
    const candidate = path.resolve(folder.uri.fsPath, ...relativePath.split('/'))
    if (!isPathWithin(folder.uri.fsPath, candidate)) throw pathNotAllowed()
    return {
      workspaceFolder: folder,
      uri: vscode.Uri.file(candidate),
      relativePath,
    }
  }

  public relativePath(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
    if (uri.scheme !== 'file') throw pathNotAllowed()
    if (!isPathWithin(folder.uri.fsPath, uri.fsPath)) throw pathNotAllowed()
    const relativePath = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/')
    if (!isCanonicalWorkspaceRelativePath(relativePath)) throw pathNotAllowed()
    return relativePath
  }

  public async assertRegularFile(resolved: ResolvedWorkspacePath): Promise<void> {
    try {
      const stat = await this.workspace.fs.stat(resolved.uri)
      if ((stat.type & vscode.FileType.File) === 0 || (stat.type & vscode.FileType.SymbolicLink) !== 0)
        throw pathNotAllowed()
    } catch (error) {
      if (error instanceof AppError) throw error
      throw pathNotAllowed()
    }
  }

  /**
   * Shape-validate a navigation hint, then fit it to the document it points at.
   * The shape is enforced because the range crosses the Webview boundary, but a
   * line past the end of the file is a stale hint, not a malformed request: the
   * document is already open by the time this runs, so clamping keeps the open
   * honest instead of reporting a failure for it.
   */
  public clampRange(document: vscode.TextDocument, range: EditorContextRange): vscode.Range {
    if (!isValidEditorContextRange(range)) throw invalidRange()
    const start = clampedPosition(document, range.start)
    const end = clampedPosition(document, range.end)
    return new vscode.Range(start.line, start.column, end.line, end.column)
  }
}

function clampedPosition(
  document: vscode.TextDocument,
  position: EditorContextPosition,
): { readonly line: number; readonly column: number } {
  const line = Math.min(position.line, Math.max(0, document.lineCount - 1))
  const lineLength = document.lineAt(line).text.length
  return { line, column: Math.min(position.column, lineLength) }
}

function pathNotAllowed(): AppError {
  return new AppError({
    code: 'PATH_NOT_ALLOWED',
    message: 'Only a validated regular file inside the selected workspace is allowed.',
    retryable: false,
  })
}

function invalidRange(): AppError {
  return new AppError({
    code: 'INVALID_CONFIGURATION',
    message: 'The editor range is not a valid position pair.',
    retryable: false,
  })
}
