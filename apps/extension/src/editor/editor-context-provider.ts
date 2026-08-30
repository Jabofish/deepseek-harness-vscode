import path from 'node:path'
import * as vscode from 'vscode'

import {
  AppError,
  EDITOR_CONTEXT_LIMITS,
  editorContextTotalBytes,
  type EditorContextAvailability,
  type EditorContextCaptureInput,
  type EditorContextItem,
  type EditorContextKind,
  type EditorContextOwner,
  type EditorContextPreview,
  type EditorContextResolveInput,
  type ResolvedEditorContext,
} from '@dsh-vscode/domain'
import type { EditorContextPort } from '@dsh-vscode/application'

import { EditorContextStore, type CurrentEditorContextContent } from './editor-context-store.js'
import { workspaceFolderId, WorkspacePathGuard } from './workspace-path-guard.js'

export const DSH_CHAT_VIEW_OWNER_ID = 'dsh.chatView'
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.css': 'text/css',
  '.go': 'text/x-go',
  '.html': 'text/html',
  '.java': 'text/x-java-source',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.py': 'text/x-python',
  '.rs': 'text/x-rust',
  '.sh': 'application/x-sh',
  '.sql': 'application/sql',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
}

export interface EditorContextProviderOptions {
  readonly ownerId?: string
  readonly ownerViewId?: string
  readonly workspace?: typeof vscode.workspace
  readonly window?: typeof vscode.window
  readonly languages?: typeof vscode.languages
  readonly now?: () => number
}

/** VS Code-facing capture and attachment resolver; all platform objects stop here. */
export class EditorContextProvider implements EditorContextPort, vscode.Disposable {
  private readonly ownerId: string
  private readonly ownerViewId: string
  private readonly workspace: typeof vscode.workspace
  private readonly window: typeof vscode.window
  private readonly languages: typeof vscode.languages
  private readonly guard: WorkspacePathGuard
  private readonly store: EditorContextStore
  private readonly contextStoreGeneration = 1
  private lifecycleGeneration = 0

  public constructor(options: EditorContextProviderOptions = {}) {
    this.ownerId = options.ownerId ?? DSH_CHAT_VIEW_OWNER_ID
    this.ownerViewId = options.ownerViewId ?? DSH_CHAT_VIEW_OWNER_ID
    this.workspace = options.workspace ?? vscode.workspace
    this.window = options.window ?? vscode.window
    this.languages = options.languages ?? vscode.languages
    this.guard = new WorkspacePathGuard(this.workspace)
    this.store = new EditorContextStore(options.now)
  }

  public capture(
    input: EditorContextCaptureInput,
    owner: EditorContextOwner,
    signal?: AbortSignal,
  ): Promise<EditorContextItem> {
    this.assertOwner(owner)
    throwIfAborted(signal)
    const lifecycleGeneration = this.lifecycleGeneration
    return this.captureActiveEditor(input, signal, lifecycleGeneration)
  }

  public list(owner: EditorContextOwner, signal?: AbortSignal): Promise<readonly EditorContextItem[]> {
    this.assertOwner(owner)
    throwIfAborted(signal)
    return this.store.list(owner)
  }

  public async availability(
    owner: EditorContextOwner,
    signal?: AbortSignal,
  ): Promise<EditorContextAvailability> {
    this.assertOwner(owner)
    throwIfAborted(signal)

    const editor = this.window.activeTextEditor
    if (editor === undefined || editor.document.uri.scheme !== 'file') return { availableKinds: [] }
    const folder = this.workspace.getWorkspaceFolder(editor.document.uri)
    if (folder === undefined) return { availableKinds: [] }
    const workspaceId = workspaceFolderId(folder)
    if (owner.workspaceFolderId !== undefined && owner.workspaceFolderId !== workspaceId)
      return { availableKinds: [] }

    let resolved: ReturnType<WorkspacePathGuard['resolve']>
    try {
      resolved = this.guard.resolve(workspaceId, this.guard.relativePath(folder, editor.document.uri))
      await this.guard.assertRegularFile(resolved)
    } catch {
      return { availableKinds: [] }
    }
    throwIfAborted(signal)

    const currentItems = await this.store.list(owner)
    const currentBytes = editorContextTotalBytes(currentItems.map((item) => item.ref))
    const canFit = (bytes: number): boolean =>
      currentItems.length < EDITOR_CONTEXT_LIMITS.maxItems &&
      currentBytes + bytes <= EDITOR_CONTEXT_LIMITS.maxTotalBytes &&
      bytes <= EDITOR_CONTEXT_LIMITS.maxItemBytes

    const availableKinds: EditorContextKind[] = []
    const fileSize = await Promise.resolve(this.workspace.fs.stat(editor.document.uri))
      .then((info) => info.size)
      .catch(() => undefined)
    if (fileSize !== undefined && canFit(fileSize)) availableKinds.push('file')

    const selection = editor.selection
    if (!selection.isEmpty) {
      const selectionBytes = Buffer.byteLength(editor.document.getText(selection), 'utf8')
      if (canFit(selectionBytes)) availableKinds.push('selection')
    }

    const selectedLine = selection.active.line
    const diagnostics = this.languages.getDiagnostics(editor.document.uri).filter(
      (diagnostic) =>
        diagnostic.range.start.line <= selectedLine && diagnostic.range.end.line >= selectedLine,
    )
    if (diagnostics.length > 0) {
      const diagnosticBytes = Buffer.byteLength(
        diagnostics.map((diagnostic) => `${diagnostic.severity}: ${diagnostic.message}`).join('\n'),
        'utf8',
      )
      if (canFit(diagnosticBytes)) availableKinds.push('diagnostic')
    }

    return { availableKinds }
  }

  public preview(
    contextRef: string,
    owner: EditorContextOwner,
    signal?: AbortSignal,
  ): Promise<EditorContextPreview> {
    this.assertOwner(owner)
    throwIfAborted(signal)
    return this.store.preview(contextRef, owner)
  }

  public release(
    contextRefs: readonly string[],
    owner: EditorContextOwner,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertOwner(owner)
    throwIfAborted(signal)
    this.store.release(contextRefs, owner)
    return Promise.resolve()
  }

  public resolveForPrompt(
    input: EditorContextResolveInput,
    signal?: AbortSignal,
  ): Promise<readonly ResolvedEditorContext[]> {
    this.assertOwner(input)
    throwIfAborted(signal)
    return this.store.resolveForPrompt(input)
  }

  public dispose(): void {
    this.lifecycleGeneration += 1
    this.store.clear()
  }

  public get size(): number {
    return this.store.size
  }

  private async captureActiveEditor(
    input: EditorContextCaptureInput,
    signal?: AbortSignal,
    lifecycleGeneration = this.lifecycleGeneration,
  ): Promise<EditorContextItem> {
    const editor = this.window.activeTextEditor
    if (editor === undefined) throw contextUnavailable('Open a text editor before adding editor context.')
    if (editor.document.uri.scheme !== 'file') throw pathNotAllowed()
    const folder = this.workspace.getWorkspaceFolder(editor.document.uri)
    if (folder === undefined) throw contextUnavailable('The active editor is outside a trusted workspace.')
    const id = workspaceFolderId(folder)
    if (input.workspaceFolderId !== undefined && input.workspaceFolderId !== id) throw resourceNotOwned()
    const resolved = this.guard.resolve(id, this.guard.relativePath(folder, editor.document.uri))
    await this.guard.assertRegularFile(resolved)
    throwIfAborted(signal)

    const range = captureRange(editor, input.kind)
    const contextRange = range === undefined ? undefined : toContextRange(range)
    const selectedLine = editor.selection.active.line
    const source = await this.readSource(editor.document, input.kind, range, selectedLine)
    this.assertCaptureIsCurrent(lifecycleGeneration, signal)
    if (source.bytes.byteLength > EDITOR_CONTEXT_LIMITS.maxItemBytes) throw contextLimit()
    const relativePath = resolved.relativePath
    const label = `${input.kind}: ${relativePath}${range === undefined ? '' : `:${range.start.line + 1}`}`
    const readCurrent = async (): Promise<CurrentEditorContextContent> => {
      // Do not retain the capture request's AbortSignal in a long-lived
      // context handle. A cancellation after capture admission must not make
      // a later prompt resolution permanently fail; lifecycle generation is
      // the ownership boundary for the stored handle.
      this.assertCaptureIsCurrent(lifecycleGeneration)
      const document = await this.openCurrentDocument(editor.document.uri)
      this.assertCaptureIsCurrent(lifecycleGeneration)
      const currentRange = captureRangeForDocument(document, input.kind, range)
      return this.readSource(document, input.kind, currentRange, selectedLine)
    }
    return this.store.capture({
      workspaceFolderId: id,
      ownerId: this.ownerId,
      ownerViewId: this.ownerViewId,
      contextStoreGeneration: this.contextStoreGeneration,
      kind: input.kind,
      relativePath,
      ...(contextRange === undefined ? {} : { range: contextRange }),
      label,
      bytes: source.bytes,
      mimeType: mimeTypeFor(relativePath),
      ...(source.documentVersion === undefined ? {} : { documentVersion: source.documentVersion }),
      readCurrent,
    })
  }

  private assertCaptureIsCurrent(lifecycleGeneration: number, signal?: AbortSignal): void {
    if (lifecycleGeneration !== this.lifecycleGeneration) throw contextStale()
    throwIfAborted(signal)
  }

  private async openCurrentDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
    const open = this.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString())
    return open ?? this.workspace.openTextDocument(uri)
  }

  private async readSource(
    document: vscode.TextDocument,
    kind: EditorContextCaptureInput['kind'],
    range: vscode.Range | undefined,
    selectedLine?: number,
  ): Promise<CurrentEditorContextContent> {
    if (kind === 'symbol')
      throw contextUnavailable('The active document has no supported symbol context provider.')
    if (kind === 'diagnostic') {
      const diagnostics = this.languages.getDiagnostics(document.uri)
      const current = diagnostics.filter(
        (diagnostic) =>
          selectedLine === undefined ||
          (diagnostic.range.start.line <= selectedLine && diagnostic.range.end.line >= selectedLine),
      )
      if (current.length === 0)
        throw contextUnavailable('No diagnostic is available at the current editor line.')
      const text = current.map((diagnostic) => `${diagnostic.severity}: ${diagnostic.message}`).join('\n')
      return { bytes: Buffer.from(text, 'utf8'), documentVersion: document.version }
    }
    if (range === undefined && document.uri.scheme === 'file') {
      const info = await Promise.resolve(this.workspace.fs.stat(document.uri)).catch(() => undefined)
      if (info !== undefined && info.size > EDITOR_CONTEXT_LIMITS.maxItemBytes) throw contextLimit()
    }
    const text = range === undefined ? document.getText() : document.getText(range)
    if (kind === 'selection' && text.length === 0)
      throw contextUnavailable('Select non-empty text before adding context.')
    return { bytes: Buffer.from(text, 'utf8'), documentVersion: document.version }
  }

  private assertOwner(owner: EditorContextOwner): void {
    if (owner.ownerId !== this.ownerId || owner.ownerViewId !== this.ownerViewId) throw resourceNotOwned()
    if (owner.contextStoreGeneration !== this.contextStoreGeneration) throw generationMismatch()
  }
}

function captureRange(
  editor: vscode.TextEditor,
  kind: EditorContextCaptureInput['kind'],
): vscode.Range | undefined {
  if (kind !== 'selection') return undefined
  if (editor.selection.isEmpty) throw contextUnavailable('Select non-empty text before adding context.')
  return new vscode.Range(editor.selection.start, editor.selection.end)
}

function captureRangeForDocument(
  document: vscode.TextDocument,
  kind: EditorContextCaptureInput['kind'],
  captured: vscode.Range | undefined,
): vscode.Range | undefined {
  if (kind !== 'selection') return undefined
  if (captured === undefined) throw contextUnavailable('The captured selection is no longer available.')
  if (
    captured.start.line >= document.lineCount ||
    captured.end.line >= document.lineCount ||
    captured.start.line > captured.end.line
  )
    throw contextStale()
  if (
    captured.start.character > document.lineAt(captured.start.line).text.length ||
    captured.end.character > document.lineAt(captured.end.line).text.length ||
    (captured.start.line === captured.end.line && captured.start.character > captured.end.character)
  )
    throw contextStale()
  return captured
}

function toContextRange(range: vscode.Range): {
  start: { line: number; column: number }
  end: { line: number; column: number }
} {
  return {
    start: { line: range.start.line, column: range.start.character },
    end: { line: range.end.line, column: range.end.character },
  }
}

function mimeTypeFor(relativePath: string): string {
  return MIME_BY_EXTENSION[path.extname(relativePath).toLowerCase()] ?? 'text/plain'
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true)
    throw new AppError({
      code: 'REQUEST_CANCELLED',
      message: 'The editor context request was cancelled.',
      retryable: true,
    })
}

function contextUnavailable(message: string): AppError {
  return new AppError({ code: 'CAPABILITY_UNAVAILABLE', message, retryable: false })
}

function contextLimit(message = 'The editor context is too large.'): AppError {
  return new AppError({ code: 'CONTEXT_LIMIT', message, retryable: false })
}

function contextStale(): AppError {
  return new AppError({
    code: 'CONTEXT_STALE',
    message: 'The editor document changed after capture.',
    retryable: false,
  })
}

function pathNotAllowed(): AppError {
  return new AppError({
    code: 'PATH_NOT_ALLOWED',
    message: 'Only a workspace file can be added as editor context.',
    retryable: false,
  })
}

function resourceNotOwned(): AppError {
  return new AppError({
    code: 'RESOURCE_NOT_OWNED',
    message: 'The editor context belongs to another view.',
    retryable: false,
  })
}

function generationMismatch(): AppError {
  return new AppError({
    code: 'GENERATION_MISMATCH',
    message: 'The editor context belongs to an older view generation.',
    retryable: false,
  })
}
