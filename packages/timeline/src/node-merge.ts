import { settledToolPresentation, type BackendEvent } from '@dsh-vscode/domain'

import type { TimelineNode } from './nodes.js'
import { findNodeIndexFromEnd } from './node-lookup.js'

export function mergeTool(
  previous: Extract<TimelineNode, { readonly kind: 'tool' }>['tool'],
  next: Extract<TimelineNode, { readonly kind: 'tool' }>['tool'],
): Extract<TimelineNode, { readonly kind: 'tool' }>['tool'] {
  const merged: Extract<TimelineNode, { readonly kind: 'tool' }>['tool'] = {
    ...previous,
    ...next,
    name: next.name === 'unknown-tool' ? previous.name : next.name,
    category: next.category === 'tool' ? previous.category : next.category,
    title: next.title === 'Tool' ? previous.title : next.title,
    ...(next.inputSummary === undefined && previous.inputSummary !== undefined
      ? { inputSummary: previous.inputSummary }
      : {}),
    ...(next.outputSummary === undefined && previous.outputSummary !== undefined
      ? { outputSummary: previous.outputSummary }
      : {}),
    metadata: { ...previous.metadata, ...next.metadata },
  }
  // The call and its result meet only here: a durable result states no name and
  // no arguments, so the card a running shell call established can be settled
  // into the card its output states only once both halves are on one row.
  const presentation = settledToolPresentation(merged.presentation, {
    name: merged.name,
    rawArguments: merged.inputSummary,
    output: merged.outputSummary,
    failed: merged.status === 'failed' || merged.error !== undefined,
    settled: merged.status === 'completed' || merged.status === 'failed' || merged.status === 'cancelled',
  })
  if (presentation === merged.presentation) return merged
  if (presentation === undefined) {
    const withoutPresentation = { ...merged }
    delete withoutPresentation.presentation
    return withoutPresentation
  }
  return { ...merged, presentation }
}

/**
 * Compaction phases arrive as separate events sharing one id. Keep the
 * summary, replaced count, and token estimate from whichever phase last
 * carried them so the collapsed row stays informative.
 */
export function mergeCompaction(
  previous: Extract<TimelineNode, { readonly kind: 'compaction' }>['compaction'],
  next: Extract<TimelineNode, { readonly kind: 'compaction' }>['compaction'],
): Extract<TimelineNode, { readonly kind: 'compaction' }>['compaction'] {
  return {
    ...previous,
    ...next,
    phase: next.phase,
    ...(next.summary === undefined && previous.summary !== undefined ? { summary: previous.summary } : {}),
    ...(next.replacedCount === undefined && previous.replacedCount !== undefined
      ? { replacedCount: previous.replacedCount }
      : {}),
    ...(next.estimatedTokens === undefined && previous.estimatedTokens !== undefined
      ? { estimatedTokens: previous.estimatedTokens }
      : {}),
  }
}

/**
 * Project one Agent Team activity onto its durable row.
 *
 * A peer message is a single stored record plus its receipt: the host appends
 * `team/message/queued` when the message is durably held, and
 * `team/message/delivered` once the target holds it — the receipt names the same
 * message id and carries no body, exactly as `team/message/delivered` is typed.
 * Keying each event by its own id showed two cards for one message: a row that
 * announced "queued" forever, and a receipt whose only text was the internal
 * `team-message-<uuid>`. Both events share the message identity, so they share
 * one row, and whichever direction they arrive in the row keeps the body and
 * sender the queued record carried while its state follows the newest fact.
 */
export function teamActivityNode(
  nodes: readonly TimelineNode[],
  activity: Extract<BackendEvent, { readonly type: 'team.updated' }>['activity'],
): TimelineNode {
  if (activity.kind === 'member' || activity.kind === 'task') {
    return { kind: 'team', id: activity.id, activity }
  }
  const id = `team:message:${activity.teamId}:${activity.messageId}`
  const index = findNodeIndexFromEnd(nodes, (node) => node.id === id)
  const previous = index < 0 ? undefined : nodes[index]
  const earlier = previous?.kind === 'team' ? previous.activity : undefined
  if (earlier?.kind !== 'message.queued' && earlier?.kind !== 'message.delivered') {
    return { kind: 'team', id, activity }
  }
  const senderName = activity.senderName ?? earlier.senderName
  const delivery = activity.delivery ?? earlier.delivery
  const content = activity.content ?? earlier.content
  return {
    kind: 'team',
    id,
    activity: {
      ...activity,
      kind:
        activity.kind === 'message.delivered' || earlier.kind === 'message.delivered'
          ? 'message.delivered'
          : 'message.queued',
      ...(senderName === undefined ? {} : { senderName }),
      ...(delivery === undefined ? {} : { delivery }),
      ...(content === undefined ? {} : { content }),
    },
  }
}
