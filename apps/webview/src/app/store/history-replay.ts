import {
  type BackendEvent,
  type SessionHistoryEvent,
  type SessionSequenceRange,
  type SessionProjectionSnapshot,
} from '@dsh-vscode/domain'
import { reduceTimelineBatch, type TimelineNode, type TimelineState } from '@dsh-vscode/timeline'
import type { HostMessage } from '@dsh-vscode/webview-protocol'
import { translate } from '../../i18n.js'
import { domainEvent, parseHostDomainEvent, timelineSequenceOptions } from './event-parser.js'
import { nonEmptyString, parseSessionProjection } from './event-values.js'
import { oldestHistorySequence, historySequenceRanges, mergeSequenceRanges } from './history-ledger.js'
import { object } from './unknown-record.js'

interface ParsedHistoryPayload {
  readonly history: readonly SessionHistoryEvent[]
  readonly timeline: readonly HydratedTimelineEntry[]
}

interface HydratedTimelineEntry {
  readonly event: BackendEvent
  readonly sequence: number
}

function parseSessionHistory(value: unknown): readonly SessionHistoryEvent[] {
  return parseHistoryPayload(value, false).history
}

/**
 * Parse the ordinary session-open payload once for both durable history and
 * timeline hydration. Malformed wrapped entries still become visible unknown
 * timeline records, matching the defensive behavior of the old two-pass path.
 */
export function parseSessionHistoryWithTimeline(value: unknown): ParsedHistoryPayload {
  return parseHistoryPayload(value, true)
}

function parseHistoryPayload(value: unknown, includeTimeline: boolean): ParsedHistoryPayload {
  if (!Array.isArray(value)) return { history: [], timeline: [] }
  const history: SessionHistoryEvent[] = []
  const timeline: HydratedTimelineEntry[] = []
  for (const [index, entry] of value.entries()) {
    const record = object(entry)
    if (record === undefined) {
      if (includeTimeline)
        timeline.push({
          event: { type: 'unknown', name: 'history/invalid-entry', payload: { index } },
          sequence: index,
        })
      continue
    }
    const eventRecord = object(record.event)
    const historyEventRecord = eventRecord ?? record
    const coveredSequences = parseCoveredSequences(record)
    const hasRecordSequence = Object.hasOwn(record, 'sequence')
    const hasEventSequence = Object.hasOwn(historyEventRecord, 'sequence')
    const hasEventSeq = Object.hasOwn(historyEventRecord, 'seq')
    const hasRecordTime = Object.hasOwn(record, 'time')
    const recordTimeValue = record.time
    const recordTime = hasRecordTime && nonEmptyString(recordTimeValue) ? recordTimeValue : undefined
    const rawSequence = hasRecordSequence
      ? record.sequence
      : hasEventSequence
        ? historyEventRecord.sequence
        : hasEventSeq
          ? historyEventRecord.seq
          : undefined
    const hasExplicitSequence = hasRecordSequence || hasEventSequence || hasEventSeq
    if (hasExplicitSequence && optionalSequence(rawSequence) === undefined)
      throw new Error(translate('app.error.malformedHistory'))
    if (hasRecordTime && !nonEmptyString(recordTime)) throw new Error(translate('app.error.malformedHistory'))
    const sequence = optionalSequence(rawSequence) ?? index
    if (
      coveredSequences !== undefined &&
      (coveredSequences.length === 0 || coveredSequences[coveredSequences.length - 1] !== sequence)
    )
      throw new Error(translate('app.error.malformedHistory'))
    const parsedEvent =
      typeof historyEventRecord?.type === 'string'
        ? domainEvent(historyEventRecord.type, historyEventRecord)
        : undefined
    if (parsedEvent !== undefined) {
      history.push({
        sequence,
        time: recordTime === undefined ? historyTime(parsedEvent) : recordTime,
        event: { ...parsedEvent, sequence },
        ...(coveredSequences === undefined ? {} : { coveredSequences }),
      })
    }
    if (!includeTimeline) continue
    if (record.event === undefined || record.event === null || typeof record.event !== 'object') {
      timeline.push({
        event: { type: 'unknown', name: 'history/missing-event', payload: { index } },
        sequence,
      })
      continue
    }
    if (eventRecord === undefined || typeof eventRecord.type !== 'string') {
      timeline.push({
        event: { type: 'unknown', name: 'history/invalid-event', payload: { index } },
        sequence,
      })
      continue
    }
    timeline.push({
      event: parsedEvent ?? { type: 'unknown', name: eventRecord.type, payload: { index } },
      sequence,
    })
  }
  // The Host normally emits the open snapshot in durable order, but an
  // overlapping reconnect/open can assemble this payload from more than one
  // source. Keep the ledger canonical before it becomes the pagination and
  // rebuild input; equal durable sequences retain their source order.
  const orderedHistory = history
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => left.entry.sequence - right.entry.sequence || left.index - right.index)
    .map(({ entry }) => entry)
  return { history: orderedHistory, timeline }
}

export function parseSessionHistoryPage(value: unknown): {
  readonly events: readonly SessionHistoryEvent[]
  readonly hasMore: boolean
  readonly beforeSequence?: number
  readonly coveredSequenceRanges?: readonly SessionSequenceRange[]
  readonly projection?: SessionProjectionSnapshot
} {
  const page = object(value)
  if (page === undefined || !Array.isArray(page.events) || typeof page.hasMore !== 'boolean')
    throw new Error(translate('app.error.malformedHistory'))
  const events = parseSessionHistory(page.events)
  const hasBeforeSequence = Object.hasOwn(page, 'beforeSeq')
  const parsedBeforeSequence = optionalSequence(page.beforeSeq)
  if (hasBeforeSequence && parsedBeforeSequence === undefined)
    throw new Error(translate('app.error.malformedHistory'))
  const beforeSequence = parsedBeforeSequence ?? oldestHistorySequence(events)
  const coveredSequenceRanges = parseCoveredSequenceRanges(page)
  const projection = parseSessionProjection(page.projection)
  return {
    events,
    hasMore: page.hasMore,
    ...(beforeSequence === undefined ? {} : { beforeSequence }),
    ...(coveredSequenceRanges === undefined ? {} : { coveredSequenceRanges }),
    ...(projection === undefined ? {} : { projection }),
  }
}

/**
 * Raw coverage a page can vouch for. A session page reports the unfiltered
 * ranges; a child-transcript page only has the rows that reached the
 * transcript, which is the same fallback a session page without ranges uses.
 */
export function historyPageCoverage(page: {
  readonly events: readonly SessionHistoryEvent[]
  readonly coveredSequenceRanges?: readonly SessionSequenceRange[]
}): readonly SessionSequenceRange[] {
  return page.coveredSequenceRanges ?? historySequenceRanges(page.events)
}

function parseCoveredSequences(record: Record<string, unknown>): readonly number[] | undefined {
  if (!Object.hasOwn(record, 'coveredSequences')) return undefined
  if (!Array.isArray(record.coveredSequences)) throw new Error(translate('app.error.malformedHistory'))
  const sequences: number[] = []
  let previous = -1
  for (const value of record.coveredSequences) {
    const sequence = optionalSequence(value)
    if (sequence === undefined || sequence <= previous)
      throw new Error(translate('app.error.malformedHistory'))
    sequences.push(sequence)
    previous = sequence
  }
  return sequences
}

function parseCoveredSequenceRanges(
  page: Record<string, unknown>,
): readonly SessionSequenceRange[] | undefined {
  if (!Object.hasOwn(page, 'coveredSeqRanges')) return undefined
  if (!Array.isArray(page.coveredSeqRanges)) throw new Error(translate('app.error.malformedHistory'))
  const ranges: SessionSequenceRange[] = []
  for (const value of page.coveredSeqRanges) {
    const range = object(value)
    const from = optionalSequence(range?.from)
    const to = optionalSequence(range?.to)
    if (from === undefined || to === undefined || to < from)
      throw new Error(translate('app.error.malformedHistory'))
    ranges.push({ from, to })
  }
  return mergeSequenceRanges([], ranges)
}

interface PendingReplayEntry {
  readonly message: HostMessage
  readonly index: number
  readonly hostSequence: number
  readonly event?: BackendEvent
  readonly durableSequence?: number
}

export function isAdvisoryReplayMessage(message: HostMessage): boolean {
  const event = parseHostDomainEvent(message)
  // Cursorless assistant frames and host-only interruption completions were
  // already applied live after first paint. Replaying them over an advisory
  // snapshot would either duplicate a settled answer or regress a still-live
  // prefix. Durable records and idempotent control events still need replay.
  return !(
    event?.type === 'message.delta' ||
    event?.type === 'reasoning.delta' ||
    (event?.type === 'message.completed' && event.interrupted === true && event.sequence === undefined)
  )
}

/**
 * Order the messages collected while a session is opening without mixing the
 * two sequence spaces. Durable DSH events must be applied in DSH order because
 * the timeline reducer rejects an older durable cursor. Alpha assistant
 * deltas are cursorless, however, and are published before their matching
 * durable `message.completed`; Host sequence is the only order that contains
 * both records. Place those transient prefixes immediately before their
 * settlement while retaining DSH order for all durable records.
 */
export function orderPendingReplayMessages(messages: readonly HostMessage[]): readonly HostMessage[] {
  const entries = messages.map<PendingReplayEntry>((message, index) => {
    const event = parseHostDomainEvent(message) ?? undefined
    return {
      message,
      index,
      hostSequence: message.type === 'event' ? message.sequence : Number.MAX_SAFE_INTEGER,
      ...(event === undefined ? {} : { event }),
      ...(event?.sequence === undefined ? {} : { durableSequence: event.sequence }),
    }
  })
  const durable = entries
    .filter((entry) => entry.durableSequence !== undefined)
    .sort(
      (left, right) =>
        left.durableSequence! - right.durableSequence! ||
        left.hostSequence - right.hostSequence ||
        left.index - right.index,
    )
  const nonDurable = entries.filter((entry) => entry.durableSequence === undefined)
  if (nonDurable.length === 0) return durable.map(({ message }) => message)

  const beforeDurable = new Map<number, PendingReplayEntry[]>()
  for (const entry of nonDurable) {
    const anchor = transientSettlementAnchor(entry, durable)
    const insertionIndex = durable.findIndex((candidate) => entry.hostSequence < candidate.hostSequence)
    const durableIndex = anchor ?? (insertionIndex < 0 ? durable.length : insertionIndex)
    const bucket = beforeDurable.get(durableIndex)
    if (bucket === undefined) beforeDurable.set(durableIndex, [entry])
    else bucket.push(entry)
  }

  const ordered: PendingReplayEntry[] = []
  for (let index = 0; index <= durable.length; index += 1) {
    const bucket = beforeDurable.get(index)
    if (bucket !== undefined)
      ordered.push(
        ...bucket.sort((left, right) => left.hostSequence - right.hostSequence || left.index - right.index),
      )
    const durableEntry = durable[index]
    if (durableEntry !== undefined) ordered.push(durableEntry)
  }
  return ordered.map(({ message }) => message)
}

function transientSettlementAnchor(
  entry: PendingReplayEntry,
  durable: readonly PendingReplayEntry[],
): number | undefined {
  const event = entry.event
  if (
    event === undefined ||
    (event.type !== 'message.delta' && event.type !== 'reasoning.delta') ||
    event.transientAttemptId === undefined ||
    event.transientIndex === undefined
  )
    return undefined
  const key = assistantReplayKey(event)
  const startedAfterSequence = event.transientStartedAfterSequence
  const attemptBoundary =
    startedAfterSequence === undefined
      ? undefined
      : (() => {
          const index = durable.findIndex(
            (candidate) =>
              candidate.durableSequence !== undefined && candidate.durableSequence > startedAfterSequence,
          )
          return index < 0 ? durable.length : index
        })()
  const afterTransient = durable.findIndex(
    (candidate) =>
      candidate.event?.type === 'message.completed' &&
      assistantReplayKey(candidate.event) === key &&
      (startedAfterSequence === undefined ||
        (candidate.durableSequence !== undefined && candidate.durableSequence > startedAfterSequence)) &&
      candidate.hostSequence >= entry.hostSequence,
  )
  if (afterTransient >= 0) return Math.max(attemptBoundary ?? 0, afterTransient)
  // An earlier settlement belongs to a previous retry. If the new attempt has
  // not produced its own settlement yet, keep the transient prefix at its
  // Host-sequence position; moving it before the old settlement would make
  // the old durable row absorb and replace the live node during replay.
  if (attemptBoundary !== undefined) {
    const insertionIndex = durable.findIndex((candidate) => entry.hostSequence < candidate.hostSequence)
    return Math.max(attemptBoundary, insertionIndex < 0 ? durable.length : insertionIndex)
  }
  return undefined
}

function assistantReplayKey(
  event: Extract<BackendEvent, { readonly type: 'message.delta' | 'reasoning.delta' | 'message.completed' }>,
): string {
  // Alpha's cursorless frame uses the deterministic turn/step fallback id,
  // while the durable assistant message carries DSH's generated message id.
  // Coordinates are the shared identity for a live attempt; only legacy
  // events without coordinates can fall back to their message id.
  return event.turn !== undefined && event.step !== undefined
    ? [event.sessionId, event.turn, event.step].join('\u0000')
    : [event.sessionId, event.messageId].join('\u0000')
}

export function optionalSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function historyTime(event: BackendEvent): string {
  const value = 'time' in event ? event.time : undefined
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : new Date().toISOString()
}

export function hydrateTimelineFromHistoryEvents(
  sessionId: string,
  history: readonly SessionHistoryEvent[],
): TimelineState {
  return hydrateTimelineFromEntries(sessionId, history)
}

type ConversationTimelineNode = Extract<TimelineNode, { readonly kind: 'assistant-message' | 'reasoning' }>

function isLiveTransientNode(node: TimelineNode): node is ConversationTimelineNode {
  if (node.kind === 'assistant-message')
    return (
      node.liveAttemptId !== undefined &&
      (node.streaming || node.reasoning?.streaming === true || node.interrupted === true)
    )
  return node.kind === 'reasoning' && node.liveAttemptId !== undefined && node.streaming
}

/**
 * A durable ledger rebuild must not erase a stream that has no durable
 * sequence yet. Keep only genuinely active transient nodes; completed nodes
 * are reconstructed from history and must not be allowed to shadow it.
 */
export function mergeLiveTransientNodes(
  rebuilt: TimelineState,
  previous: TimelineState,
  history: readonly SessionHistoryEvent[] = [],
): TimelineState {
  const liveNodes = previous.nodes.filter(isLiveTransientNode)
  if (liveNodes.length === 0) return rebuilt

  const nodes = [...rebuilt.nodes]
  for (const live of liveNodes) {
    // `assistant/attempt` is a durable non-visible settlement. If the
    // rebuilt history already contains the settlement for this attempt, do
    // not reattach the old process-local prefix just because the durable row
    // intentionally produces no TimelineNode.
    if (findMatchingAssistantAttempt(history, rebuilt.sessionId, live) !== undefined) continue
    const index = findMatchingTransientNode(nodes, live)
    if (index < 0) {
      const settlement = findMatchingSettledAssistant(nodes, live)
      // DSH's assistant stream carries the durable cursor immediately before
      // the attempt started. A settlement at or below that cursor belongs to
      // an earlier retry and must remain beside the still-live attempt; only a
      // later settlement retires the live prefix during a ledger rebuild.
      if (
        settlement === undefined ||
        (live.liveStartedAfterSequence !== undefined &&
          settlement.sequence !== undefined &&
          settlement.sequence <= live.liveStartedAfterSequence)
      )
        insertLiveNodeAtPreviousPosition(nodes, previous.nodes, live)
      continue
    }
    const current = nodes[index]
    if (current === undefined) {
      nodes.push(live)
      continue
    }
    nodes[index] = mergeTransientNode(current, live)
  }
  return {
    ...rebuilt,
    nodes,
    nodeChangeBase: rebuilt.nodes,
    nodeChangeStart: 0,
  }
}

/**
 * Rebuilding from the durable ledger can remove a process-local stream row
 * while retaining the durable rows that were adjacent to it. Re-append would
 * move the live answer below later tool/deliverable rows, so restore it beside
 * the nearest durable neighbour from the previous transcript instead.
 */
function insertLiveNodeAtPreviousPosition(
  nodes: TimelineNode[],
  previousNodes: readonly TimelineNode[],
  live: TimelineNode,
): void {
  const previousIndex = previousNodes.indexOf(live)
  if (previousIndex >= 0) {
    for (let index = previousIndex + 1; index < previousNodes.length; index += 1) {
      const anchor = previousNodes[index]
      if (anchor === undefined || isLiveTransientNode(anchor)) continue
      const currentIndex = findStableTimelineNodeIndex(nodes, anchor)
      if (currentIndex >= 0) {
        nodes.splice(currentIndex, 0, live)
        return
      }
    }
    for (let index = previousIndex - 1; index >= 0; index -= 1) {
      const anchor = previousNodes[index]
      if (anchor === undefined || isLiveTransientNode(anchor)) continue
      const currentIndex = findStableTimelineNodeIndex(nodes, anchor)
      if (currentIndex >= 0) {
        nodes.splice(currentIndex + 1, 0, live)
        return
      }
    }
  }

  const boundary = 'liveStartedAfterSequence' in live ? live.liveStartedAfterSequence : undefined
  if (boundary !== undefined) {
    const laterIndex = nodes.findIndex((node) => {
      const sequence = timelineNodeSequence(node)
      return sequence !== undefined && sequence > boundary
    })
    if (laterIndex >= 0) {
      nodes.splice(laterIndex, 0, live)
      return
    }
  }
  nodes.push(live)
}

function findStableTimelineNodeIndex(nodes: readonly TimelineNode[], anchor: TimelineNode): number {
  return nodes.findIndex((node) => node.kind === anchor.kind && node.id === anchor.id)
}

function timelineNodeSequence(node: TimelineNode): number | undefined {
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

function findMatchingAssistantAttempt(
  history: readonly SessionHistoryEvent[],
  sessionId: string | undefined,
  live: ConversationTimelineNode,
): SessionHistoryEvent | undefined {
  if (
    sessionId === undefined ||
    live.kind !== 'assistant-message' ||
    live.turn === undefined ||
    live.step === undefined ||
    live.liveStartedAfterSequence === undefined
  )
    return undefined
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index]
    if (
      entry?.event.type === 'assistant.attempt' &&
      entry.event.sessionId === sessionId &&
      entry.event.turn === live.turn &&
      entry.event.step === live.step &&
      entry.sequence > live.liveStartedAfterSequence
    )
      return entry
  }
  return undefined
}

function isSettledDurableAssistant(
  node: TimelineNode,
): node is Extract<TimelineNode, { readonly kind: 'assistant-message' }> {
  return (
    node.kind === 'assistant-message' &&
    node.sequence !== undefined &&
    !node.streaming &&
    node.reasoning?.streaming !== true
  )
}

function findMatchingTransientNode(nodes: readonly TimelineNode[], live: ConversationTimelineNode): number {
  const byId = findNodeIndexFromEnd(
    nodes,
    (node) =>
      (node.kind === 'assistant-message' || node.kind === 'reasoning') &&
      node.id === live.id &&
      isOpenTransientConversationNode(node),
  )
  if (byId >= 0) return byId
  if (live.kind !== 'assistant-message' || live.turn === undefined || live.step === undefined) return -1
  return findNodeIndexFromEnd(
    nodes,
    (node) =>
      node.kind === 'assistant-message' &&
      node.turn === live.turn &&
      node.step === live.step &&
      isOpenTransientConversationNode(node),
  )
}

function findMatchingSettledAssistant(
  nodes: readonly TimelineNode[],
  live: ConversationTimelineNode,
): Extract<TimelineNode, { readonly kind: 'assistant-message' }> | undefined {
  const index = findNodeIndexFromEnd(nodes, (node) => {
    if (!isSettledDurableAssistant(node)) return false
    if (node.id === live.id) return true
    return (
      live.kind === 'assistant-message' &&
      live.turn !== undefined &&
      live.step !== undefined &&
      node.turn === live.turn &&
      node.step === live.step
    )
  })
  const node = index < 0 ? undefined : nodes[index]
  return node?.kind === 'assistant-message' ? node : undefined
}

function isOpenTransientConversationNode(node: TimelineNode): boolean {
  if (node.kind === 'assistant-message')
    return node.streaming || node.reasoning?.streaming === true || node.liveAttemptId !== undefined
  return node.kind === 'reasoning' && node.streaming
}

function findNodeIndexFromEnd(
  nodes: readonly TimelineNode[],
  predicate: (node: TimelineNode) => boolean,
): number {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node !== undefined && predicate(node)) return index
  }
  return -1
}

function mergeTransientNode(current: TimelineNode, live: ConversationTimelineNode): TimelineNode {
  if (live.kind === 'assistant-message' && current.kind === 'assistant-message') {
    const merged = {
      ...current,
      markdown: live.markdown,
      streaming: live.streaming,
      ...(live.turn === undefined ? {} : { turn: live.turn }),
      ...(live.step === undefined ? {} : { step: live.step }),
      ...(live.liveAttemptId === undefined ? {} : { liveAttemptId: live.liveAttemptId }),
      ...(live.liveLastIndex === undefined ? {} : { liveLastIndex: live.liveLastIndex }),
      ...(live.liveStartedAfterSequence === undefined
        ? {}
        : { liveStartedAfterSequence: live.liveStartedAfterSequence }),
      ...(live.interrupted === undefined ? {} : { interrupted: live.interrupted }),
    }
    if (live.reasoning === undefined) delete merged.reasoning
    else merged.reasoning = live.reasoning
    return merged
  }
  if (live.kind === 'reasoning' && current.kind === 'assistant-message')
    return {
      ...current,
      reasoning: { markdown: live.markdown, streaming: live.streaming },
      ...(live.liveAttemptId === undefined ? {} : { liveAttemptId: live.liveAttemptId }),
      ...(live.liveLastIndex === undefined ? {} : { liveLastIndex: live.liveLastIndex }),
      ...(live.liveStartedAfterSequence === undefined
        ? {}
        : { liveStartedAfterSequence: live.liveStartedAfterSequence }),
    }
  return live
}

export function hydrateTimelineFromEntries(
  sessionId: string,
  valid: readonly HydratedTimelineEntry[],
): TimelineState {
  let timeline: TimelineState = {
    sessionId,
    nodes: [],
    lastSequence: valid.length === 0 ? -1 : Number.MIN_SAFE_INTEGER,
    eventCount: 0,
  }
  // DSH history pages are already emitted in sequence order on the common
  // path. Avoid an eager copy plus O(n log n) sort during every session open;
  // retain the sort fallback for defensive handling of malformed or merged
  // pages that arrive out of order.
  const ordered = isNonDecreasingBySequence(valid)
    ? valid
    : [...valid].sort((left, right) => left.sequence - right.sequence)
  timeline = reduceTimelineBatch(
    timeline,
    ordered.map(({ event, sequence }) => ({
      sequence,
      event,
      // Projection/lifecycle records carry durable sequence metadata but are
      // not conversation records. Keep their state updates while preventing
      // them from consuming the timeline cursor during history rehydration.
      ...timelineSequenceOptions(event),
    })),
  )
  const lastSequence = ordered.reduce(
    (maximum, entry) =>
      timelineSequenceOptions(entry.event).advanceSequence === false
        ? maximum
        : Math.max(maximum, entry.sequence),
    -1,
  )
  return ordered.length === 0 ? timeline : { ...timeline, lastSequence }
}

function isNonDecreasingBySequence(entries: readonly HydratedTimelineEntry[]): boolean {
  let previous: number | undefined
  for (const entry of entries) {
    if (previous !== undefined && entry.sequence < previous) return false
    previous = entry.sequence
  }
  return true
}
