import type { BackendEvent } from '@dsh-vscode/domain'

import type { TimelineNode } from './nodes.js'

/**
 * Live DSH updates target the newest node in an append-ordered transcript.
 * Keep malformed/legacy collections deterministic by returning the newest
 * matching id, which is also the reducer's unique-id invariant after upsert.
 */
export function findNodeIndexFromEnd(
  nodes: readonly TimelineNode[],
  predicate: (node: TimelineNode) => boolean,
): number {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node !== undefined && predicate(node)) return index
  }
  return -1
}

export function upsert(nodes: TimelineNode[], node: TimelineNode): void {
  const index = findNodeIndexFromEnd(nodes, (existing) => existing.id === node.id)
  if (index < 0) nodes.push(node)
  else nodes[index] = node
}

/**
 * Unknown events are intentionally preserved, but they can be delivered after
 * a known projection has already occupied the transcript. Insert them before
 * the first later durable sequence so enabling the DSH event view does not
 * turn every future event into a block at the bottom of the conversation.
 */
export function insertSequencedNode(nodes: TimelineNode[], node: TimelineNode): boolean {
  const existingIndex = nodes.findIndex((existing) => existing.id === node.id)
  if (existingIndex >= 0) {
    const existing = nodes[existingIndex]
    nodes[existingIndex] = node
    return existing?.kind !== 'event' && node.kind === 'event'
  }
  const sequence = nodeSequence(node)
  if (sequence === undefined) {
    nodes.push(node)
    return node.kind === 'event'
  }
  const laterIndex = nodes.findIndex((existing) => {
    const existingSequence = nodeSequence(existing)
    return existingSequence !== undefined && existingSequence > sequence
  })
  if (laterIndex < 0) nodes.push(node)
  else nodes.splice(laterIndex, 0, node)
  return node.kind === 'event'
}

export function countEventNodes(nodes: readonly TimelineNode[]): number {
  let count = 0
  for (const node of nodes) if (node.kind === 'event') count += 1
  return count
}

export function nodeSequence(node: TimelineNode): number | undefined {
  switch (node.kind) {
    case 'assistant-message':
    case 'tool':
    case 'deliverables':
    case 'retry':
    case 'turn-terminal':
    case 'event':
      return node.sequence
    default:
      return undefined
  }
}

export function conversationNodeIndex(
  nodes: readonly TimelineNode[],
  messageId: string,
  turn?: number,
  step?: number,
  transient = false,
): number {
  const exactIndex = findNodeIndexFromEnd(nodes, (node) => {
    if (node.id !== messageId || (node.kind !== 'assistant-message' && node.kind !== 'reasoning'))
      return false
    return !transient || isOpenConversationNode(node)
  })
  if (exactIndex >= 0 || turn === undefined || step === undefined) return exactIndex
  return findNodeIndexFromEnd(
    nodes,
    (node) =>
      node.kind === 'assistant-message' &&
      node.turn === turn &&
      node.step === step &&
      isOpenConversationNode(node),
  )
}

export function isOpenConversationNode(node: TimelineNode): boolean {
  if (node.kind === 'assistant-message')
    return node.streaming || node.reasoning?.streaming === true || node.liveAttemptId !== undefined
  return node.kind === 'reasoning' && node.streaming
}

export function settleAssistantNode(
  node: Extract<TimelineNode, { readonly kind: 'assistant-message' }>,
  preserveTransientIdentity: boolean,
): Extract<TimelineNode, { readonly kind: 'assistant-message' }> {
  if (preserveTransientIdentity) return node
  const settled = { ...node }
  delete settled.liveAttemptId
  delete settled.liveLastIndex
  delete settled.liveStartedAfterSequence
  return settled
}

/**
 * Whether a durable `message.user` is the message a local preview stood in for.
 *
 * The durable projection does not carry the draft's media types: images become
 * nameless durable image references, and a file the adapter inlined as a text
 * block comes back as its display name alone. Comparing the two attachment
 * lists field by field therefore never matched a message that carried anything,
 * and the user saw their own steering or subagent message twice. Correspondence
 * by kind is what identifies the message: each image the preview showed must be
 * one of the event's image references, and every other name must line up in
 * order with the event's named attachments.
 *
 * The event may also carry attachments the draft never had. Editor-context
 * chips are resolved into prompt attachments inside the Extension Host and are
 * appended after the draft's own, so the preview's names are the leading ones
 * and anything beyond them belongs to content the Webview never listed.
 */
export function sameUserMessagePreview(
  node: Extract<TimelineNode, { readonly kind: 'user-message' }>,
  event: Extract<BackendEvent, { readonly type: 'message.user' }>,
): boolean {
  if (node.markdown !== event.markdown) return false
  const previewAttachments = node.attachments ?? []
  if (previewAttachments.length === 0) return true
  const names: string[] = []
  let imageCount = 0
  for (const attachment of previewAttachments) {
    if (attachment.mimeType?.startsWith('image/') === true) imageCount += 1
    else names.push(attachment.name)
  }
  const eventNames = (event.attachments ?? []).map((attachment) => attachment.name)
  return (
    imageCount === (event.images ?? []).length &&
    names.length <= eventNames.length &&
    names.every((name, index) => name === eventNames[index])
  )
}
