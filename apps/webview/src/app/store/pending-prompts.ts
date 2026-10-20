import type { PromptAttachment, QueuedInput, RunningInputMode } from '@dsh-vscode/domain'

/**
 * A queue-mode prompt the Host accepted locally before DSH projected it.
 * `queueIdsBefore` pins existing rows and rows already used to confirm another
 * receipt, so a repeated snapshot can never confirm this submission twice.
 */
export interface PendingPromptReceipt extends QueuedInput {
  readonly queueIdsBefore: readonly string[]
}

/**
 * Native inbox admission can publish a row even for an idle direct send. It
 * is still represented by the composer's pending submission, not the queue
 * dock. Match each receipt once and never hide an older identical queued row.
 */
export function withoutDirectPromptRows(
  rows: readonly QueuedInput[],
  receipts: readonly PendingPromptReceipt[],
): readonly QueuedInput[] {
  if (receipts.length === 0 || rows.length === 0) return rows
  const identified = new Set(rows.flatMap((row) => (row.rpcId === undefined ? [] : [row.rpcId])))
  const unmatched = [...receipts]
  const visible = rows.filter((row) => {
    let index = unmatched.findIndex(
      (receipt) =>
        receipt.sessionId === row.sessionId &&
        !receipt.queueIdsBefore.includes(row.id) &&
        row.rpcId !== undefined &&
        receipt.rpcId === row.rpcId,
    )
    // Older profiles omit the browser request identity from queue records.
    if (index < 0 && row.rpcId === undefined)
      index = unmatched.findIndex(
        (receipt) =>
          (receipt.rpcId === undefined || !identified.has(receipt.rpcId)) &&
          !receipt.queueIdsBefore.includes(row.id) &&
          sameQueuedPromptContent(receipt, row),
      )
    if (index < 0) return true
    unmatched.splice(index, 1)
    return false
  })
  return visible.length === rows.length ? rows : visible
}

function isImageAttachment(attachment: PromptAttachment): boolean {
  return attachment.mimeType?.startsWith('image/') === true
}

function sameStringLists(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameAttachmentLists(left: readonly PromptAttachment[], right: readonly PromptAttachment[]): boolean {
  if (left.length !== right.length) return false
  return left.every((attachment, index) => {
    const other = right[index]
    return other?.name === attachment.name && other.mimeType === attachment.mimeType
  })
}

/**
 * Whether a projected queue row carries this submission's content.
 *
 * Identity by `rpcId` is preferred wherever DSH forwards it. The rc.6 family
 * does not, so the row is reconstructed from the same content blocks: text
 * files become `files` names and images become durable references. A row that
 * still carries opaque attachment handles is compared by name instead.
 */
export function matchesQueuedPrompt(
  row: QueuedInput,
  text: string,
  mode: RunningInputMode,
  attachments: readonly PromptAttachment[],
): boolean {
  if (row.text !== text || row.mode !== mode) return false
  if (row.attachments.length > 0) return sameAttachmentLists(attachments, row.attachments)
  const images = attachments.filter(isImageAttachment).length
  const files = attachments
    .filter((attachment) => !isImageAttachment(attachment))
    .map((attachment) => attachment.name)
    .sort()
  return images === (row.images?.length ?? 0) && sameStringLists(files, [...(row.files ?? [])].sort())
}

export function sameQueuedPromptContent(left: QueuedInput, right: QueuedInput): boolean {
  return (
    left.sessionId === right.sessionId && matchesQueuedPrompt(right, left.text, left.mode, left.attachments)
  )
}

function wasAlreadyQueued(receipt: QueuedInput, row: QueuedInput): boolean {
  return (receipt as Partial<PendingPromptReceipt>).queueIdsBefore?.includes(row.id) === true
}

/**
 * Drop the receipts this queue snapshot proves are now authoritative rows.
 *
 * Matching is one-to-one and ignores rows that predated a receipt, so two
 * identical sends keep distinct receipts until DSH projects two rows. Returns
 * `undefined` when the snapshot confirms nothing, preserving state identity.
 */
export function confirmPendingPrompts<Receipt extends QueuedInput>(
  pending: readonly Receipt[],
  rows: readonly QueuedInput[],
): readonly Receipt[] | undefined {
  if (pending.length === 0 || rows.length === 0) return undefined
  const usedRows = new Set<string>()
  const confirmed = new Set<Receipt>()
  const eligible = (receipt: Receipt, row: QueuedInput): boolean =>
    receipt.sessionId === row.sessionId &&
    !confirmed.has(receipt) &&
    !usedRows.has(row.id) &&
    !wasAlreadyQueued(receipt, row)
  for (const receipt of pending) {
    if (receipt.rpcId === undefined) continue
    const row = rows.find((candidate) => eligible(receipt, candidate) && candidate.rpcId === receipt.rpcId)
    if (row === undefined) continue
    usedRows.add(row.id)
    confirmed.add(receipt)
  }
  for (const receipt of pending) {
    if (confirmed.has(receipt)) continue
    const row = rows.find(
      (candidate) =>
        eligible(receipt, candidate) &&
        (candidate.rpcId === undefined || receipt.rpcId === undefined) &&
        sameQueuedPromptContent(receipt, candidate),
    )
    if (row === undefined) continue
    usedRows.add(row.id)
    confirmed.add(receipt)
  }
  if (confirmed.size === 0) return undefined
  return pending
    .filter((receipt) => !confirmed.has(receipt))
    .map((receipt) => {
      const consumed = rows.filter((row) => usedRows.has(row.id) && row.sessionId === receipt.sessionId)
      if (consumed.length === 0) return receipt
      const before = (receipt as Partial<PendingPromptReceipt>).queueIdsBefore ?? []
      return { ...receipt, queueIdsBefore: [...new Set([...before, ...consumed.map((row) => row.id)])] }
    })
}
