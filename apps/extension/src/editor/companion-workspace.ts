import { realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import * as vscode from 'vscode'
import { EditorCompanionError, isCanonicalWorkspaceRelativePath, type EditorRange } from '@dsh-vscode/domain'
import { isPathWithin } from '../backend/path-safety.js'

/** Generous guard against opening enormous files; the returned text is capped separately. */
const COMPANION_MAX_BYTES = 67_108_864

/**
 * Every trusted workspace root in the window, addressed as `<root name>/<relative path>` when
 * there is more than one. Untitled buffers are readable through the active editor only.
 */
export class CompanionWorkspace {
  private readonly labels = new Map<vscode.WorkspaceFolder, string>()
  private readonly drafts = new Map<string, vscode.TextDocument>()
  public constructor(
    public readonly folders: readonly vscode.WorkspaceFolder[],
    private readonly current: () => boolean,
  ) {
    const used = new Set<string>()
    for (const [index, folder] of folders.entries()) {
      const name = Array.from(folder.name.trim(), (character) => {
        const code = character.codePointAt(0) ?? 0
        return code < 32 || code === 127 || ['\\', '/', ':'].includes(character) ? '_' : character
      }).join('')
      const base = name === '' || name === '.' || name === '..' ? `root-${index + 1}` : name
      let label = base
      let suffix = 1
      while (used.has(label.toLowerCase())) label = `${base}~${++suffix}`
      used.add(label.toLowerCase())
      this.labels.set(folder, label)
    }
  }
  public get multi(): boolean {
    return this.folders.length > 1
  }
  public assert(signal: AbortSignal): void {
    signal.throwIfAborted()
    if (!vscode.workspace.isTrusted) throw new EditorCompanionError('untrusted')
    const open = vscode.workspace.workspaceFolders ?? []
    if (
      !this.current() ||
      this.folders.length === 0 ||
      !this.folders.every((folder) => open.includes(folder))
    )
      throw new EditorCompanionError('workspace-mismatch')
  }
  public label(folder: vscode.WorkspaceFolder): string {
    return this.labels.get(folder) ?? folder.name
  }
  /** The root that contains a real file, resolved in this window's own filesystem. */
  public folderOf(uri: vscode.Uri): vscode.WorkspaceFolder {
    const folder = [...this.folders]
      .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)
      .find(
        (candidate) =>
          candidate.uri.scheme === uri.scheme &&
          candidate.uri.authority === uri.authority &&
          isPathWithin(candidate.uri.fsPath, uri.fsPath),
      )
    if (folder === undefined) throw new EditorCompanionError('workspace-mismatch')
    if (
      folder.uri.scheme !== 'file' &&
      !(folder.uri.scheme === 'vscode-remote' && vscode.env.remoteName !== undefined)
    )
      throw new EditorCompanionError('unsupported')
    return folder
  }
  public relative(uri: vscode.Uri): string {
    // An untitled buffer has no path; its label is only ever returned, never accepted as input.
    if (uri.scheme === 'untitled') {
      for (const [label, document] of this.drafts)
        if (document.uri.toString() === uri.toString()) return label
      const document = vscode.window.activeTextEditor?.document
      if (document?.uri.toString() !== uri.toString()) throw new EditorCompanionError('unavailable')
      for (const [label, item] of this.drafts) if (item.isClosed) this.drafts.delete(label)
      if (this.drafts.size >= 16) this.drafts.delete(this.drafts.keys().next().value ?? '')
      const label = `__dsh_drafts__/${randomUUID()}`
      this.drafts.set(label, document)
      return label
    }
    const folder = this.folderOf(uri)
    const relative = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/')
    if (!isCanonicalWorkspaceRelativePath(relative)) throw new EditorCompanionError('workspace-mismatch')
    return this.multi ? `${this.label(folder)}/${relative}` : relative
  }
  public async validate(
    uri: vscode.Uri,
    signal: AbortSignal,
    maxBytes: number = COMPANION_MAX_BYTES,
  ): Promise<string> {
    this.assert(signal)
    if (uri.scheme === 'untitled') throw new EditorCompanionError('workspace-mismatch')
    const folder = this.folderOf(uri)
    const relative = this.relative(uri)
    try {
      const [root, file, stat] = await Promise.all([
        realpath(folder.uri.fsPath),
        realpath(uri.fsPath),
        vscode.workspace.fs.stat(uri),
      ])
      // A symlink is fine as long as its real target stays inside the root it belongs to.
      if (!isPathWithin(root, file) || (stat.type & vscode.FileType.File) === 0)
        throw new EditorCompanionError('workspace-mismatch')
      if (stat.size > maxBytes) throw new EditorCompanionError('limit')
    } catch (error) {
      this.assert(signal)
      if (error instanceof EditorCompanionError) throw error
      throw fileFailure(error)
    }
    this.assert(signal)
    return relative
  }
  public async document(
    relativePath: string | undefined,
    signal: AbortSignal,
    maxBytes: number = COMPANION_MAX_BYTES,
  ): Promise<vscode.TextDocument> {
    this.assert(signal)
    let uri: vscode.Uri
    if (relativePath === undefined) {
      const editor = vscode.window.activeTextEditor
      if (editor === undefined) throw new EditorCompanionError('no-editor')
      // Read-only access to an unsaved draft: there is no path to validate, and no write path.
      if (editor.document.uri.scheme === 'untitled') {
        if (editor.document.isClosed) throw new EditorCompanionError('unavailable')
        return editor.document
      }
      uri = editor.document.uri
    } else {
      const draft = this.drafts.get(relativePath)
      if (draft !== undefined) {
        if (draft.isClosed) throw new EditorCompanionError('unavailable')
        return draft
      }
      uri = this.resolve(relativePath)
    }
    await this.validate(uri, signal, maxBytes)
    let document: vscode.TextDocument
    try {
      document =
        vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString()) ??
        (await vscode.workspace.openTextDocument(uri))
    } catch (error) {
      this.assert(signal)
      throw fileFailure(error)
    }
    await this.validate(document.uri, signal, maxBytes)
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
  private resolve(relativePath: string): vscode.Uri {
    if (!isCanonicalWorkspaceRelativePath(relativePath)) throw new EditorCompanionError('workspace-mismatch')
    if (!this.multi) {
      const only = this.folders[0]
      if (only === undefined) throw new EditorCompanionError('workspace-mismatch')
      return vscode.Uri.joinPath(only.uri, ...relativePath.split('/'))
    }
    const slash = relativePath.indexOf('/')
    if (slash <= 0) throw new EditorCompanionError('workspace-mismatch')
    const label = relativePath.slice(0, slash)
    const folder = this.folders.find((candidate) => this.label(candidate) === label)
    if (folder === undefined) throw new EditorCompanionError('workspace-mismatch')
    return vscode.Uri.joinPath(folder.uri, ...relativePath.slice(slash + 1).split('/'))
  }
}
function fileFailure(error: unknown): EditorCompanionError {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return new EditorCompanionError(
    code === 'ENOENT' || code === 'ENOTDIR' || code === 'FileNotFound' ? 'not-found' : 'file-access',
  )
}
export function companionRange(range: vscode.Range): EditorRange {
  return {
    start: { line: range.start.line + 1, column: range.start.character + 1 },
    end: { line: range.end.line + 1, column: range.end.character + 1 },
  }
}
