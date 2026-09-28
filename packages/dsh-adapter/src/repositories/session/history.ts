import type {
  SessionDetail,
  SessionHistoryEvent,
  SessionSequenceRange,
  SessionSummary,
} from '@dsh-vscode/domain'
import { asRecord, firstString } from './configuration.js'

/**
 * DSH persists every streaming assistant chunk as a history event. Those
 * chunks are useful on the wire while a turn is running, but forwarding them
 * individually makes history rendering look like many separate replies. Only
 * collapse adjacent deltas of the same message: a tool/lifecycle row is a hard
 * ordering boundary, so deltas on opposite sides must remain separate. A
 * completed message already carries the authoritative assembled text, so its
 * duplicate deltas are not needed by the timeline.
 */
export function compactHistoryEvents(events: readonly SessionHistoryEvent[]): readonly SessionHistoryEvent[] {
  const completedMessages = new Set<string>()
  for (const entry of events) {
    const event = entry.event
    if (event.type === 'message.completed' && (event.markdown !== undefined || event.reasoning !== undefined))
      completedMessages.add(event.messageId)
  }

  const compacted: SessionHistoryEvent[] = []
  let previousDeltaKey: string | undefined
  let previousDeltaIndex = -1
  for (const entry of events) {
    const event = entry.event
    // block/tool/usage/finish chunks are stream bookkeeping. Visible tool
    // calls/results and the completed assistant message are mapped separately;
    // retaining every bookkeeping row would recreate the protocol overflow.
    if (event.type === 'unknown' && event.name.startsWith('assistant/chunk')) {
      previousDeltaKey = undefined
      previousDeltaIndex = -1
      continue
    }
    if (event.type !== 'message.delta' && event.type !== 'reasoning.delta') {
      compacted.push(entry)
      previousDeltaKey = undefined
      previousDeltaIndex = -1
      continue
    }
    if (completedMessages.has(event.messageId)) {
      previousDeltaKey = undefined
      previousDeltaIndex = -1
      continue
    }

    const key = `${event.type}:${event.messageId}`
    if (key !== previousDeltaKey) {
      previousDeltaKey = key
      previousDeltaIndex = compacted.length
      compacted.push(entry)
      continue
    }
    const existing = compacted[previousDeltaIndex]
    if (existing === undefined) continue
    if (existing.event.type === 'message.delta' && event.type === 'message.delta') {
      const sequence = Math.max(existing.sequence, entry.sequence)
      const coveredSequences = mergeCoveredSequences(existing, entry)
      compacted[previousDeltaIndex] = {
        ...existing,
        // Keep the newest durable sequence on the compacted row. The Webview
        // uses it as its replay watermark; retaining the first sequence would
        // let a live delta already covered by history be appended twice.
        sequence,
        event: { ...existing.event, delta: `${existing.event.delta}${event.delta}`, sequence },
        ...(coveredSequences.length > 1 ? { coveredSequences } : {}),
      }
    } else if (existing.event.type === 'reasoning.delta' && event.type === 'reasoning.delta') {
      const sequence = Math.max(existing.sequence, entry.sequence)
      const coveredSequences = mergeCoveredSequences(existing, entry)
      compacted[previousDeltaIndex] = {
        ...existing,
        sequence,
        event: { ...existing.event, delta: `${existing.event.delta}${event.delta}`, sequence },
        ...(coveredSequences.length > 1 ? { coveredSequences } : {}),
      }
    }
  }
  // Keep the public page ordered even if a future mapper supplies a
  // non-monotonic sequence; the index tie-breaker preserves source order.
  return compacted
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => left.entry.sequence - right.entry.sequence || left.index - right.index)
    .map(({ entry }) => entry)
}

function mergeCoveredSequences(left: SessionHistoryEvent, right: SessionHistoryEvent): readonly number[] {
  return [
    ...new Set([
      ...(left.coveredSequences ?? [left.sequence]),
      ...(right.coveredSequences ?? [right.sequence]),
    ]),
  ].sort((first, second) => first - second)
}

export function sequenceRanges(sequences: readonly number[]): readonly SessionSequenceRange[] {
  const ordered = [...new Set(sequences)].sort((first, second) => first - second)
  const ranges: SessionSequenceRange[] = []
  for (const sequence of ordered) {
    const previous = ranges[ranges.length - 1]
    if (previous !== undefined && sequence === previous.to + 1) {
      ranges[ranges.length - 1] = { ...previous, to: sequence }
    } else {
      ranges.push({ from: sequence, to: sequence })
    }
  }
  return ranges
}

export function fallbackSessionSummary(
  sessionId: string,
  history: readonly SessionHistoryEvent[],
  rawHistory: readonly unknown[],
  workspaceId: string | undefined,
  projectionBlock: SessionDetail['projection'] | undefined,
  deriveTitleFromCwd: boolean,
): SessionSummary {
  const first = history[0]?.time
  const last = history[history.length - 1]?.time
  const hasHumanMessage = history.some(
    (entry) => entry.event.type === 'message.user' && entry.event.source !== 'command',
  )
  const statusEvent = [...history].reverse().find((entry) => entry.event.type === 'session.status')?.event
  const projection = history
    .slice()
    .reverse()
    .find((entry) => entry.event.type === 'session.projection' && entry.event.key === 'title')?.event
  const projectionTitleFromEvent =
    projection?.type === 'session.projection' && typeof projection.value === 'string'
      ? projection.value.trim() || undefined
      : undefined
  const projectionTitle = firstString(projectionBlock?.values.title, projectionTitleFromEvent)
  const cwd = historyCwd(rawHistory)
  const derivedTitle =
    deriveTitleFromCwd && hasHumanMessage ? (workspaceTitleFromPath(cwd) ?? sessionId) : 'New Session'
  return {
    id: sessionId,
    workspaceId: workspaceId ?? '',
    ...(cwd === undefined ? {} : { cwd }),
    title: projectionTitle ?? derivedTitle,
    blank: !hasHumanMessage,
    status:
      statusEvent?.type === 'session.status'
        ? statusEvent.status === 'running'
          ? 'running'
          : statusEvent.status === 'awaiting-input'
            ? 'awaiting-input'
            : statusEvent.status === 'failed'
              ? 'failed'
              : statusEvent.status === 'completed'
                ? 'completed'
                : 'idle'
        : // A history without a durable status row is either a New Session the
          // host still calls blank, or a finished turn. `completed` is terminal
          // for every downstream consumer (the task center drops such rows),
          // and it contradicts the host's own list row for the same Session.
          !hasHumanMessage
          ? 'idle'
          : 'completed',
    createdAt: first ?? new Date().toISOString(),
    updatedAt: last ?? first ?? new Date().toISOString(),
  }
}

function workspaceTitleFromPath(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const segments = value
    .trim()
    .replace(/[\\/]+$/u, '')
    .split(/[\\/]/u)
    .filter(Boolean)
  return segments.at(-1)
}

export function historyCwd(history: readonly unknown[]): string | undefined {
  for (const entry of history) {
    const wrapper = asRecord(entry)
    const event = asRecord(wrapper.event ?? wrapper)
    const data = asRecord(event.data)
    const header = asRecord(data.header)
    const session = asRecord(data.session)
    const meta = asRecord(data.meta)
    const cwd = firstString(data.cwd, data.workingDirectory, header.cwd, session.cwd, meta.cwd)
    if (cwd !== undefined) return cwd
  }
  return undefined
}
