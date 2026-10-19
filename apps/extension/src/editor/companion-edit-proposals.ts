import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import {
  EditorCompanionError,
  type EditorCompanionValue,
  type EditorProposalStatus,
  type EditorTextEdit,
} from '@dsh-vscode/domain'
import type { CompanionWorkspace } from './companion-workspace.js'

type Receipt = Extract<EditorCompanionValue, { kind: 'proposal' }>
interface Proposal {
  readonly id: string
  readonly path: string
  readonly originalVersion: number
  readonly edits: readonly EditorTextEdit[]
  readonly expiresAt: number
  before: string
  after: string
  status: EditorProposalStatus
  version: number
}

/** Proposals cannot write. A separate native user action reviews and applies them. */
export class CompanionEditProposals implements vscode.Disposable {
  private readonly proposals = new Map<string, Proposal>()
  private readonly lifetime = new AbortController()
  private provider: vscode.Disposable | undefined
  private reviewing = false
  public constructor(
    private readonly workspace: CompanionWorkspace,
    private readonly changed: () => void,
  ) {}
  public create(
    document: vscode.TextDocument,
    relativePath: string,
    expectedVersion: number,
    edits: readonly EditorTextEdit[],
    signal: AbortSignal,
  ): Receipt {
    this.workspace.assert(signal)
    this.prune()
    if (document.version !== expectedVersion) throw new EditorCompanionError('stale-document')
    if (this.proposals.size >= 8) throw new EditorCompanionError('busy')
    const last = document.lineAt(document.lineCount - 1)
    if (document.offsetAt(new vscode.Position(document.lineCount - 1, last.text.length)) > 262_144)
      throw new EditorCompanionError('limit')
    const before = document.getText()
    const replacements = edits
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
    const id = randomUUID()
    const proposal: Proposal = {
      id,
      path: relativePath,
      originalVersion: expectedVersion,
      version: expectedVersion,
      edits: edits.map((edit) => ({
        range: { start: { ...edit.range.start }, end: { ...edit.range.end } },
        text: edit.text,
      })),
      expiresAt: Date.now() + 600_000,
      before,
      after,
      status: 'pending',
    }
    this.proposals.set(id, proposal)
    this.changed()
    void vscode.window
      .showInformationMessage(
        `DSH proposed edits to ${relativePath}. Review the diff before applying.`,
        'Review',
      )
      .then(
        (choice) => {
          if (choice === 'Review') void this.review(id)
        },
        () => undefined,
      )
    return this.receipt(proposal)
  }
  public get(id: string): Receipt {
    this.prune()
    const proposal = this.proposals.get(id)
    if (proposal === undefined) throw new EditorCompanionError('unavailable')
    return this.receipt(proposal)
  }
  public pending(): readonly Receipt[] {
    this.prune()
    return [...this.proposals.values()]
      .filter((proposal) => proposal.status === 'pending')
      .map((proposal) => this.receipt(proposal))
  }
  public async review(id: string): Promise<void> {
    const proposal = this.proposals.get(id)
    if (proposal === undefined || proposal.status !== 'pending' || this.reviewing) return
    this.reviewing = true
    const signal = this.lifetime.signal
    try {
      const document = await this.workspace.document(proposal.path, signal)
      if (document.version !== proposal.originalVersion || document.getText() !== proposal.before) {
        this.settle(proposal, 'stale')
        return
      }
      this.provider ??= vscode.workspace.registerTextDocumentContentProvider('dsh-editor-review', {
        provideTextDocumentContent: (uri) => {
          const [, proposalId, side] = uri.path.split('/')
          const candidate = proposalId === undefined ? undefined : this.proposals.get(proposalId)
          return side === 'before' ? (candidate?.before ?? '') : (candidate?.after ?? '')
        },
      })
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.from({ scheme: 'dsh-editor-review', path: `/${id}/before` }),
        vscode.Uri.from({ scheme: 'dsh-editor-review', path: `/${id}/after` }),
        `DSH proposed edit: ${proposal.path}`,
        { preview: true },
      )
      this.workspace.assert(signal)
      const choice = await vscode.window.showWarningMessage(
        `Review the diff for ${proposal.path}, then choose Apply to make an unsaved, undoable edit.`,
        {
          // Keep the diff interactive while the native confirmation remains available.
          modal: false,
        },
        'Apply',
        'Decline',
      )
      this.workspace.assert(signal)
      if (choice === 'Decline') {
        this.settle(proposal, 'declined')
        return
      }
      if (choice !== 'Apply') return
      const current = await this.workspace.document(proposal.path, signal)
      const editor = await vscode.window.showTextDocument(current, { preview: false })
      this.workspace.assert(signal)
      if (
        Date.now() >= proposal.expiresAt ||
        proposal.status !== 'pending' ||
        current.version !== proposal.originalVersion ||
        current.getText() !== proposal.before
      ) {
        this.settle(proposal, 'stale')
        return
      }
      // TextEditor.edit captures the document version and rejects edits if it changes in flight.
      const applied = await editor.edit(
        (builder) => {
          this.workspace.assert(signal)
          for (const edit of proposal.edits)
            builder.replace(this.workspace.range(current, edit.range), edit.text)
        },
        { undoStopBefore: true, undoStopAfter: true },
      )
      proposal.version = current.version
      this.settle(proposal, applied ? 'applied' : 'stale')
    } catch {
      this.settle(proposal, signal.aborted ? 'cancelled' : 'stale')
      if (!signal.aborted)
        void vscode.window.showWarningMessage(
          'The edit proposal could not be applied. Refresh the document and request a new proposal.',
        )
    } finally {
      this.reviewing = false
    }
  }
  public dispose(): void {
    this.lifetime.abort()
    for (const proposal of this.proposals.values())
      if (proposal.status === 'pending') this.settle(proposal, 'cancelled')
    this.proposals.clear()
    this.provider?.dispose()
  }
  private receipt(proposal: Proposal): Receipt {
    return {
      kind: 'proposal',
      proposalId: proposal.id,
      relativePath: proposal.path,
      status: proposal.status,
      version: proposal.version,
    }
  }
  private settle(proposal: Proposal, status: EditorProposalStatus): void {
    proposal.status = status
    proposal.before = ''
    proposal.after = ''
    this.changed()
  }
  private prune(): void {
    for (const [id, proposal] of this.proposals) {
      if (Date.now() >= proposal.expiresAt) {
        if (proposal.status === 'pending') this.settle(proposal, 'cancelled')
        this.proposals.delete(id)
      }
    }
  }
}
