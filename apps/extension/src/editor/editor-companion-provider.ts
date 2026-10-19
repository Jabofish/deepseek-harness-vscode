import * as vscode from 'vscode'
import {
  EDITOR_COMPANION_LIMITS,
  EditorCompanionError,
  editorCapability,
  isEditorCompanionRequest,
  type EditorCompanionCapability,
  type EditorCompanionPort,
  type EditorCompanionRequest,
  type EditorCompanionValue,
  type EditorLocation,
  type EditorSymbolLocation,
} from '@dsh-vscode/domain'
import { CompanionWorkspace, companionRange } from './companion-workspace.js'
import { CompanionEditProposals } from './companion-edit-proposals.js'

export class EditorCompanionProvider implements EditorCompanionPort, vscode.Disposable {
  public readonly proposals: CompanionEditProposals
  private readonly workspace: CompanionWorkspace
  private disposed = false
  public constructor(
    folder: vscode.WorkspaceFolder,
    private readonly capabilities: readonly EditorCompanionCapability[],
    current: () => boolean,
    changed: () => void = () => undefined,
  ) {
    this.workspace = new CompanionWorkspace(folder, () => !this.disposed && current())
    this.proposals = new CompanionEditProposals(this.workspace, changed)
  }
  public async execute(request: EditorCompanionRequest, signal: AbortSignal): Promise<EditorCompanionValue> {
    this.workspace.assert(signal)
    if (!isEditorCompanionRequest(request)) throw new EditorCompanionError('invalid-response')
    const capability = editorCapability(request)
    if (capability !== undefined && !this.capabilities.includes(capability))
      throw new EditorCompanionError('denied')
    if (request.kind === 'proposal') return this.proposals.get(request.proposalId)
    if (request.kind === 'symbols' && request.query !== undefined)
      return this.language(request, undefined, signal)
    const active = vscode.window.activeTextEditor
    const document = await this.workspace.document('path' in request ? request.path : undefined, signal)
    this.workspace.assert(signal)
    const relativePath = this.workspace.relative(document.uri)
    if (
      (request.kind === 'state' ||
        request.kind === 'selection' ||
        !('path' in request) ||
        request.path === undefined) &&
      vscode.window.activeTextEditor !== active
    )
      throw new EditorCompanionError('stale-document')
    switch (request.kind) {
      case 'state': {
        if (active === undefined || active.document !== document) throw new EditorCompanionError('no-editor')
        const diagnostics = vscode.languages.getDiagnostics(document.uri)
        return {
          kind: 'state',
          state: {
            relativePath,
            languageId: document.languageId,
            documentVersion: document.version,
            dirty: document.isDirty,
            selection: companionRange(active.selection),
            diagnostics: {
              errors: diagnostics.filter((item) => item.severity === vscode.DiagnosticSeverity.Error).length,
              warnings: diagnostics.filter((item) => item.severity === vscode.DiagnosticSeverity.Warning)
                .length,
            },
            capturedAt: new Date().toISOString(),
          },
        }
      }
      case 'document':
      case 'selection': {
        if (
          request.kind === 'document' &&
          request.expectedVersion !== undefined &&
          request.expectedVersion !== document.version
        )
          throw new EditorCompanionError('stale-document')
        let range: vscode.Range
        if (request.kind === 'selection') {
          if (active === undefined || active.document !== document || active.selection.isEmpty)
            throw new EditorCompanionError('no-editor')
          range = active.selection
        } else {
          const start = request.startLine ?? 1
          const end = Math.min(request.endLine ?? document.lineCount, document.lineCount)
          if (start > document.lineCount) throw new EditorCompanionError('stale-document')
          range = new vscode.Range(start - 1, 0, end - 1, document.lineAt(end - 1).text.length)
        }
        const originalLength = document.offsetAt(range.end) - document.offsetAt(range.start)
        const truncated = originalLength > EDITOR_COMPANION_LIMITS.text
        if (truncated)
          range = new vscode.Range(
            range.start,
            document.positionAt(document.offsetAt(range.start) + EDITOR_COMPANION_LIMITS.text),
          )
        let text = document.getText(range)
        if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1)
        if (text.length < originalLength)
          range = new vscode.Range(
            range.start,
            document.positionAt(document.offsetAt(range.start) + text.length),
          )
        return {
          kind: 'document',
          relativePath,
          languageId: document.languageId,
          version: document.version,
          dirty: document.isDirty,
          range: companionRange(range),
          text,
          truncated: text.length < originalLength,
        }
      }
      case 'diagnostics': {
        const diagnostics = vscode.languages.getDiagnostics(document.uri)
        return {
          kind: 'diagnostics',
          relativePath,
          version: document.version,
          capturedAt: new Date().toISOString(),
          cached: true,
          truncated: diagnostics.length > (request.limit ?? 100),
          items: diagnostics.slice(0, request.limit ?? 100).map((item) => ({
            range: companionRange(item.range),
            severity:
              item.severity === vscode.DiagnosticSeverity.Error
                ? 'error'
                : item.severity === vscode.DiagnosticSeverity.Warning
                  ? 'warning'
                  : item.severity === vscode.DiagnosticSeverity.Information
                    ? 'information'
                    : 'hint',
            message: item.message.slice(0, 2000),
            source: (item.source ?? '').slice(0, 128),
            code: String(typeof item.code === 'object' ? item.code.value : (item.code ?? '')).slice(0, 128),
          })),
        }
      }
      case 'symbols':
      case 'definitions':
      case 'references':
        return this.language(request, document, signal)
      case 'open': {
        const range = this.workspace.range(document, {
          start: { line: request.line ?? 1, column: request.column ?? 1 },
          end: { line: request.line ?? 1, column: request.column ?? 1 },
        })
        const editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true })
        this.workspace.assert(signal)
        editor.selection = new vscode.Selection(range.start, range.end)
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
        return { kind: 'opened', relativePath }
      }
      case 'propose':
        return this.proposals.create(document, relativePath, request.expectedVersion, request.edits, signal)
    }
  }
  public dispose(): void {
    this.disposed = true
    this.proposals.dispose()
  }
  private async language(
    request: Extract<EditorCompanionRequest, { kind: 'symbols' | 'definitions' | 'references' }>,
    document: vscode.TextDocument | undefined,
    signal: AbortSignal,
  ): Promise<EditorCompanionValue> {
    const version = document?.version
    let raw: unknown
    try {
      if (request.kind === 'symbols')
        raw =
          request.query === undefined && document !== undefined
            ? await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri)
            : await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', request.query)
      else {
        if (document === undefined) throw new EditorCompanionError('no-editor')
        const position = this.workspace.range(document, {
          start: { line: request.line, column: request.column },
          end: { line: request.line, column: request.column },
        }).start
        raw = await vscode.commands.executeCommand(
          request.kind === 'definitions'
            ? 'vscode.executeDefinitionProvider'
            : 'vscode.executeReferenceProvider',
          document.uri,
          position,
        )
      }
    } catch {
      this.workspace.assert(signal)
      throw new EditorCompanionError('unsupported')
    }
    this.workspace.assert(signal)
    if (document !== undefined && document.version !== version)
      throw new EditorCompanionError('stale-document')
    if (!Array.isArray(raw)) throw new EditorCompanionError('unsupported')
    const candidates: {
      uri: vscode.Uri
      range: vscode.Range
      name: string
      symbolKind: number
      container: string
    }[] = []
    let truncated = raw.length > 1000
    const collect = (entries: readonly unknown[], depth: number, container: string): void => {
      if (depth > 16) {
        truncated = true
        return
      }
      for (const entry of entries.slice(0, 1000)) {
        if (candidates.length >= 1000) {
          truncated = true
          return
        }
        if (!record(entry)) continue
        const location = record(entry.location) ? entry.location : entry
        const uri =
          location.uri ?? entry.targetUri ?? (request.kind === 'symbols' ? document?.uri : undefined)
        const range = location.range ?? entry.targetSelectionRange ?? entry.targetRange
        if (!(uri instanceof vscode.Uri) || !vscodeRange(range)) continue
        const name = typeof entry.name === 'string' ? entry.name.slice(0, 512) : ''
        candidates.push({
          uri,
          range,
          name,
          symbolKind:
            typeof entry.kind === 'number' &&
            Number.isInteger(entry.kind) &&
            entry.kind >= 0 &&
            entry.kind <= 25
              ? entry.kind
              : 0,
          container: typeof entry.containerName === 'string' ? entry.containerName.slice(0, 512) : container,
        })
        if (request.kind === 'symbols' && Array.isArray(entry.children))
          collect(entry.children, depth + 1, name)
      }
    }
    collect(raw, 0, '')
    const items: EditorSymbolLocation[] = []
    const locations: EditorLocation[] = []
    let excluded = 0
    const seen = new Set<string>()
    const limit = request.limit ?? 100
    for (const candidate of candidates) {
      this.workspace.assert(signal)
      if (items.length + locations.length >= limit) {
        truncated = true
        break
      }
      let relativePath: string
      try {
        relativePath = await this.workspace.validate(candidate.uri, signal)
      } catch (error) {
        if (error instanceof EditorCompanionError && error.reason === 'workspace-mismatch') {
          excluded += 1
          continue
        }
        throw error
      }
      const range = companionRange(candidate.range)
      const key = JSON.stringify([relativePath, range, candidate.name])
      if (seen.has(key)) continue
      seen.add(key)
      if (request.kind === 'symbols')
        items.push({
          relativePath,
          range,
          name: candidate.name,
          symbolKind: candidate.symbolKind,
          container: candidate.container,
        })
      else locations.push({ relativePath, range })
    }
    this.workspace.assert(signal)
    if (document !== undefined && document.version !== version)
      throw new EditorCompanionError('stale-document')
    return request.kind === 'symbols'
      ? { kind: 'symbols', items, truncated, excluded }
      : { kind: 'locations', items: locations, truncated, excluded }
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function vscodeRange(value: unknown): value is vscode.Range {
  if (!record(value) || !record(value.start) || !record(value.end)) return false
  return (
    [value.start.line, value.start.character, value.end.line, value.end.character].every(
      (item) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item < 1_000_000_000,
    ) &&
    (Number(value.start.line) < Number(value.end.line) ||
      (value.start.line === value.end.line && Number(value.start.character) <= Number(value.end.character)))
  )
}
