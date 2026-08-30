import { createHash } from 'node:crypto'
import path from 'node:path'
import * as vscode from 'vscode'

import { AppError, isCanonicalWorkspaceRelativePath, type EditorContextRange } from '@dsh-vscode/domain'

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

  public assertRange(document: vscode.TextDocument, range: EditorContextRange): vscode.Range {
    if (!validPosition(document, range.start) || !validPosition(document, range.end)) throw invalidRange()
    return new vscode.Range(range.start.line, range.start.column, range.end.line, range.end.column)
  }
}

function validPosition(
  document: vscode.TextDocument,
  position: { readonly line: number; readonly column: number },
): boolean {
  if (!Number.isSafeInteger(position.line) || position.line < 0 || position.line >= document.lineCount)
    return false
  const lineLength = document.lineAt(position.line).text.length
  return Number.isSafeInteger(position.column) && position.column >= 0 && position.column <= lineLength
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
    message: 'The editor range is outside the current document.',
    retryable: false,
  })
}
