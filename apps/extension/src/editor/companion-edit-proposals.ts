import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import {
  EditorCompanionError,
  type EditorCompanionValue,
  type EditorPosition,
  type EditorTextEdit,
} from '@dsh-vscode/domain'
import type { CompanionWorkspace } from './companion-workspace.js'
import { revertEdit, type EditEntry, type EditLedger } from './edit-ledger.js'

type Receipt = Extract<EditorCompanionValue, { kind: 'proposal' }>
export interface Applied {
  readonly proposalId: string
  readonly relativePath: string
  readonly uri: vscode.Uri
  readonly saved?: boolean
  readonly lines: readonly (readonly [number, number])[]
}

/**
 * Edits apply immediately without opening or focusing a tab. Only an initially
 * clean buffer is saved; user-owned unsaved changes stay in the buffer.
 * A version change no longer discards the edit on its own: when the agent's ranges sit
 * entirely outside the span the user just changed, they are rebased and applied.
 */
export class CompanionEditProposals implements vscode.Disposable {
  private readonly lifetime = new AbortController()
  private writing = false
  public constructor(
    private readonly workspace: CompanionWorkspace,
    private readonly ledger: EditLedger,
    private readonly onApplied: (applied: Applied) => void = () => undefined,
  ) {}

  public async create(
    document: vscode.TextDocument,
    relativePath: string,
    expectedVersion: number,
    edits: readonly EditorTextEdit[],
    signal: AbortSignal,
    base?: string,
  ): Promise<Receipt> {
    this.workspace.assert(signal)
    if (this.writing) throw new EditorCompanionError('busy')
    const last = document.lineAt(document.lineCount - 1)
    if (document.offsetAt(new vscode.Position(document.lineCount - 1, last.text.length)) > 262_144)
      throw new EditorCompanionError('limit')
    const before = document.getText()
    let effective = edits
    // The buffer the agent read is known: use it to tell a real conflict from a change elsewhere.
    if (document.version !== expectedVersion) {
      if (base === undefined) throw new EditorCompanionError('stale-document')
      if (base !== before) effective = rebase(base, before, edits, document)
    }
    const replacements = effective
      .map((edit) => {
        const range = this.workspace.range(document, edit.range)
        return { start: document.offsetAt(range.start), end: document.offsetAt(range.end), text: edit.text }
      })
      .sort((left, right) => left.start - right.start || left.end - right.end)
    for (let index = 1; index < replacements.length; index += 1) {
      const previous = replacements[index - 1]
      const current = replacements[index]
      if (
        previous !== undefined &&
        current !== undefined &&
        (previous.end > current.start || previous.start === current.start)
      )
        throw new EditorCompanionError('invalid-response')
    }
    let after = before
    for (const edit of replacements.toReversed())
      after = after.slice(0, edit.start) + edit.text + after.slice(edit.end)
    if (after.length > 262_144) throw new EditorCompanionError('limit')
    const entry: EditEntry = {
      id: randomUUID(),
      uri: document.uri,
      relativePath,
      folderPath: this.workspace.folderOf(document.uri).uri.fsPath,
      before,
      after,
      region: region(before, replacements),
      version: document.version,
      status: 'pending',
    }
    this.ledger.record(entry)
    this.writing = true
    try {
      await this.apply(entry, document, effective, AbortSignal.any([signal, this.lifetime.signal]))
    } finally {
      this.writing = false
    }
    return this.receipt(entry)
  }

  public get(id: string): Receipt {
    const entry = this.ledger.get(id)
    if (entry === undefined) throw new EditorCompanionError('not-found')
    return this.receipt(entry)
  }

  public lastApplied(): Receipt | undefined {
    const entry = this.ledger.lastApplied()
    return entry === undefined ? undefined : this.receipt(entry)
  }

  /** Reverts one applied edit group when the agent's span is still unambiguous. */
  public async undo(id: string): Promise<boolean> {
    const entry = this.ledger.get(id)
    if (entry === undefined || (entry.status !== 'applied' && entry.status !== 'uncertain')) return false
    const outcome = await revertEdit(entry, () => this.workspace.assert(this.lifetime.signal))
    if (outcome !== 'reverted') return false
    this.ledger.settle(entry, 'reverted')
    return true
  }

  /** Revocation ends this grant only; the ledger keeps the last edit undoable. */
  public dispose(): void {
    this.lifetime.abort()
  }

  private async apply(
    entry: EditEntry,
    document: vscode.TextDocument,
    edits: readonly EditorTextEdit[],
    signal: AbortSignal,
  ): Promise<void> {
    if (document.version !== entry.version || document.getText() !== entry.before) {
      this.ledger.settle(entry, 'stale')
      return
    }
    let dispatched = false
    try {
      this.workspace.assert(signal)
      const maySave = !document.isDirty
      const change = new vscode.WorkspaceEdit()
      for (const edit of edits)
        change.replace(document.uri, this.workspace.range(document, edit.range), edit.text)
      dispatched = true
      const applied = await vscode.workspace.applyEdit(change)
      entry.version = document.version
      const observed = document.getText()
      this.ledger.settle(
        entry,
        applied || observed === entry.after ? 'applied' : observed === entry.before ? 'stale' : 'uncertain',
      )
      if (!applied && entry.status !== 'stale') entry.saved = false
      if (applied) {
        entry.saved = false
        try {
          this.workspace.assert(signal)
          if (maySave) {
            await this.workspace.validate(document.uri, signal)
            // User typing while apply/validation was pending must not be saved
            // together with the agent edit.
            if (document.getText() === entry.after) entry.saved = (await document.save()) && !document.isDirty
          }
        } catch {
          /* Never turn an applied edit into a failed mutation because saving failed. */
        }
        entry.version = document.version
      }
    } catch {
      // A native reply can fail after writing. The current buffer confirms an
      // exact result; otherwise retain the snapshot without claiming no write.
      entry.version = document.version
      entry.saved = false
      this.ledger.settle(
        entry,
        dispatched ? (document.getText() === entry.after ? 'applied' : 'uncertain') : 'stale',
      )
    }
    if (entry.status === 'applied') {
      try {
        this.onApplied({
          proposalId: entry.id,
          relativePath: entry.relativePath,
          uri: document.uri,
          saved: entry.saved === true,
          lines: edits.map((edit) => [edit.range.start.line, edit.range.end.line] as const),
        })
      } catch {
        /* An optional UI indicator cannot turn a successful write into a failed tool result. */
      }
    }
  }

  private receipt(entry: EditEntry): Receipt {
    return {
      kind: 'proposal',
      proposalId: entry.id,
      relativePath: entry.relativePath,
      status: entry.status,
      version: entry.version,
      ...(entry.saved === undefined ? {} : { saved: entry.saved }),
    }
  }
}

/** The smallest span covering every replacement, in both coordinate systems. */
function region(
  before: string,
  replacements: readonly { start: number; end: number; text: string }[],
): { before: string; after: string; start: number } {
  const first = replacements[0]
  const last = replacements.at(-1)
  if (first === undefined || last === undefined) return { before: '', after: '', start: 0 }
  let after = ''
  let cursor = first.start
  for (const edit of replacements) {
    after += before.slice(cursor, edit.start) + edit.text
    cursor = edit.end
  }
  after += before.slice(cursor, last.end)
  return { before: before.slice(first.start, last.end), after, start: first.start }
}

/**
 * Maps edits made against `base` onto `current`. Safe by construction: only edits that sit
 * entirely outside the span the user changed are shifted; anything overlapping it conflicts.
 */
function rebase(
  base: string,
  current: string,
  edits: readonly EditorTextEdit[],
  document: vscode.TextDocument,
): EditorTextEdit[] {
  const prefix = commonPrefix(base, current)
  const suffix = commonSuffix(base, current, prefix)
  const boundary = base.length - suffix
  const shift = current.length - base.length
  return edits.map((edit) => {
    const start = offsetAt(base, edit.range.start)
    const end = offsetAt(base, edit.range.end)
    if (start === undefined || end === undefined || end < start)
      throw new EditorCompanionError('stale-document')
    let nextStart: number
    let nextEnd: number
    if (end <= prefix) {
      nextStart = start
      nextEnd = end
    } else if (start >= boundary) {
      nextStart = start + shift
      nextEnd = end + shift
    } else throw new EditorCompanionError('stale-document')
    const range = new vscode.Range(document.positionAt(nextStart), document.positionAt(nextEnd))
    return {
      range: {
        start: { line: range.start.line + 1, column: range.start.character + 1 },
        end: { line: range.end.line + 1, column: range.end.character + 1 },
      },
      text: edit.text,
    }
  })
}

function commonPrefix(base: string, current: string): number {
  const max = Math.min(base.length, current.length)
  let index = 0
  while (index < max && base.charCodeAt(index) === current.charCodeAt(index)) index += 1
  // Never split a surrogate pair.
  if (index > 0 && index < max && isLowSurrogate(base.charCodeAt(index))) index -= 1
  return index
}

function commonSuffix(base: string, current: string, prefix: number): number {
  const max = Math.min(base.length, current.length) - prefix
  let suffix = 0
  while (
    suffix < max &&
    base.charCodeAt(base.length - 1 - suffix) === current.charCodeAt(current.length - 1 - suffix)
  )
    suffix += 1
  if (suffix > 0 && isLowSurrogate(base.charCodeAt(base.length - suffix))) suffix -= 1
  return suffix
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function offsetAt(text: string, position: EditorPosition): number | undefined {
  const lines = text.split('\n')
  const line = position.line - 1
  if (line < 0 || line >= lines.length) return undefined
  const column = position.column - 1
  const content = lines[line] ?? ''
  if (column < 0 || column > content.length) return undefined
  let offset = 0
  for (let index = 0; index < line; index += 1) offset += (lines[index] ?? '').length + 1
  return offset + column
}
