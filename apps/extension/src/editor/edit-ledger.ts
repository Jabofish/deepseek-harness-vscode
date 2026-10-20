import * as vscode from 'vscode'
import { realpath } from 'node:fs/promises'
import { isPathWithin } from '../backend/path-safety.js'
import type { EditorProposalStatus } from '@dsh-vscode/domain'

/** Enough history to undo a short sequence of agent edits without keeping old buffers forever. */
const KEEP = 8
/** A local revert only runs when the touched span is small enough to be unambiguous. */
const MAX_REGION = 20_000
/** Progressively wider context, so a short span like `return null;` can still be located. */
const PADS = [0, 200, 800, 3_000]

export interface EditEntry {
  readonly id: string
  readonly uri: vscode.Uri
  readonly relativePath: string
  readonly folderPath: string
  before: string
  after: string
  /** The span the agent touched: its text in both documents and its offset in `after`. */
  readonly region: { readonly before: string; readonly after: string; readonly start: number }
  version: number
  status: EditorProposalStatus
  saved?: boolean
}
export type RevertOutcome = 'reverted' | 'changed' | 'unavailable'

/**
 * The undo record belongs to the editor, not to one sharing grant: it survives a reconnect,
 * a session switch and a stopped grant, so the single safety net never disappears on its own.
 */
export class EditLedger {
  private readonly entries = new Map<string, EditEntry>()
  public record(entry: EditEntry): void {
    this.entries.set(entry.id, entry)
    this.prune()
  }
  public get(id: string): EditEntry | undefined {
    return this.entries.get(id)
  }
  public lastApplied(): EditEntry | undefined {
    return [...this.entries.values()]
      .filter((entry) => entry.status === 'applied' || entry.status === 'uncertain')
      .at(-1)
  }
  public settle(entry: EditEntry, status: EditorProposalStatus): void {
    entry.status = status
    // Keep the original text only while the edit can still be reverted.
    if (status !== 'applied' && status !== 'uncertain') {
      entry.before = ''
      entry.after = ''
    }
    this.prune()
  }
  public clear(): void {
    for (const entry of this.entries.values()) {
      entry.before = ''
      entry.after = ''
    }
    this.entries.clear()
  }
  private prune(): void {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= KEEP) break
      if (entry.status !== 'pending') this.entries.delete(id)
    }
  }
}

/**
 * Reverts one applied edit group without opening or switching editors. An untouched buffer is
 * reverted whole; a buffer the user edited elsewhere is reverted locally when the agent's own
 * span can still be located, so one stray keystroke no longer discards the safety net.
 */
export async function revertEdit(entry: EditEntry, guard: () => void): Promise<RevertOutcome> {
  if (entry.status !== 'applied' && entry.status !== 'uncertain') return 'changed'
  try {
    guard()
  } catch {
    return 'unavailable'
  }
  let document: vscode.TextDocument
  try {
    const [root, file] = await Promise.all([realpath(entry.folderPath), realpath(entry.uri.fsPath)])
    if (!isPathWithin(root, file)) return 'unavailable'
    document = await vscode.workspace.openTextDocument(entry.uri)
  } catch {
    return 'unavailable'
  }
  try {
    guard()
  } catch {
    return 'unavailable'
  }
  const text = document.getText()
  if (entry.status === 'uncertain' && text === entry.before) {
    entry.version = document.version
    return 'reverted'
  }
  const edit = new vscode.WorkspaceEdit()
  let expected: string
  if (text === entry.after) {
    const last = document.lineAt(document.lineCount - 1)
    edit.replace(entry.uri, new vscode.Range(0, 0, document.lineCount - 1, last.text.length), entry.before)
    expected = entry.before
  } else {
    const span = locate(entry, text)
    if (span === undefined) return 'changed'
    edit.replace(entry.uri, span, entry.region.before)
    expected =
      text.slice(0, document.offsetAt(span.start)) +
      entry.region.before +
      text.slice(document.offsetAt(span.end))
  }
  const maySave = !document.isDirty
  try {
    if (!(await vscode.workspace.applyEdit(edit))) return 'changed'
    entry.saved = false
    try {
      guard()
      if (maySave) {
        const [root, file] = await Promise.all([realpath(entry.folderPath), realpath(document.uri.fsPath)])
        if (!isPathWithin(root, file)) throw new Error('Revert target changed')
        guard()
        if (document.getText() === expected) entry.saved = (await document.save()) && !document.isDirty
      }
    } catch {
      /* The revert succeeded in the buffer; its save outcome stays explicit. */
    }
    entry.version = document.version
    return 'reverted'
  } catch {
    return 'changed'
  }
}

/**
 * Finds the agent's span in a changed buffer. Widening the context removes the ambiguity of a
 * short, repeated span such as `return null;` without ever touching anything outside it.
 */
function locate(entry: EditEntry, text: string): vscode.Range | undefined {
  const span = entry.region.after
  if (span === '' || span.length > MAX_REGION) return undefined
  const start = entry.region.start
  for (const pad of PADS) {
    const from = Math.max(0, start - pad)
    const to = Math.min(entry.after.length, start + span.length + pad)
    const probe = entry.after.slice(from, to)
    if (probe === '') continue
    const at = text.indexOf(probe)
    if (at < 0 || text.indexOf(probe, at + 1) >= 0) continue
    const core = at + (start - from)
    return new vscode.Range(positionOf(text, core), positionOf(text, core + span.length))
  }
  return undefined
}

function positionOf(text: string, offset: number): vscode.Position {
  let line = 0
  let lineStart = 0
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1
      lineStart = index + 1
    }
  }
  return new vscode.Position(line, offset - lineStart)
}
