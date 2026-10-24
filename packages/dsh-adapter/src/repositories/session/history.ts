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
  let pending: SessionHistoryEvent | undefined
  let fragments: string[] = []
  let covered = new Set<number>()
  let sequence = 0
  const flush = (): void => {
    if (pending === undefined) return
    if (
      fragments.length === 1 ||
      (pending.event.type !== 'message.delta' && pending.event.type !== 'reasoning.delta')
    ) {
      compacted.push(pending)
    } else {
      const coveredSequences = [...covered].sort((first, second) => first - second)
      compacted.push({
        ...pending,
        // Keep the newest durable sequence as the replay watermark, even if
        // the mapper supplies chunks out of sequence order.
        sequence,
        event: { ...pending.event, delta: fragments.join(''), sequence },
        ...(coveredSequences.length > 1 ? { coveredSequences } : {}),
      })
    }
    pending = undefined
    previousDeltaKey = undefined
  }
  for (const entry of events) {
    const event = entry.event
    // block/tool/usage/finish chunks are stream bookkeeping. Visible tool
    // calls/results and the completed assistant message are mapped separately;
    // retaining every bookkeeping row would recreate the protocol overflow.
    if (event.type === 'unknown' && event.name.startsWith('assistant/chunk')) {
      flush()
      continue
    }
    if (event.type !== 'message.delta' && event.type !== 'reasoning.delta') {
      flush()
      compacted.push(entry)
      continue
    }
    if (completedMessages.has(event.messageId)) {
      flush()
      continue
    }

    const key = `${event.type}:${event.messageId}`
    if (key !== previousDeltaKey) {
      flush()
      previousDeltaKey = key
      pending = entry
      fragments = []
      covered = new Set<number>()
      sequence = entry.sequence
    }
    fragments.push(event.delta)
    sequence = Math.max(sequence, entry.sequence)
    for (const value of entry.coveredSequences ?? [entry.sequence]) covered.add(value)
  }
  flush()
  // Keep the public page ordered even if a future mapper supplies a
  // non-monotonic sequence; the index tie-breaker preserves source order.
  return compacted
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => left.entry.sequence - right.entry.sequence || left.index - right.index)
    .map(({ entry }) => entry)
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

/** Positive facts from a page remain valid even when older turns are omitted. */
export function sessionListFactsFromHistory(
  history: readonly SessionHistoryEvent[],
  rawHistory: readonly unknown[],
): { readonly nonblank: boolean; readonly lastPromptAt?: number } {
  const lastPrompt = [...rawHistory].reverse().find((entry) => {
    const wrapper = asRecord(entry)
    const event = asRecord(wrapper.event ?? wrapper)
    return event.type === 'user/message' && asRecord(asRecord(event.data).source).kind === 'user'
  })
  const wrapper = asRecord(lastPrompt)
  const time = asRecord(wrapper.event ?? wrapper).time
  return {
    nonblank: lastPrompt !== undefined || history.some((entry) => entry.event.type === 'turn.started'),
    ...(typeof time === 'number' &&
    Number.isSafeInteger(time) &&
    time >= 0 &&
    Number.isFinite(new Date(time).getTime())
      ? { lastPromptAt: time }
      : {}),
  }
}

export function fallbackSessionSummary(
  sessionId: string,
  history: readonly SessionHistoryEvent[],
  rawHistory: readonly unknown[],
  workspaceId: string | undefined,
  projectionBlock: SessionDetail['projection'] | undefined,
  deriveTitleFromCwd: boolean,
  hasMore = false,
): SessionSummary {
  const first = history[0]?.time
  const facts = sessionListFactsFromHistory(history, rawHistory)
  const last = facts.lastPromptAt === undefined ? undefined : new Date(facts.lastPromptAt).toISOString()
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
    blank: !facts.nonblank && !hasMore,
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
        : // Durable turns cannot prove the current Agent's runtime status.
          // A subsequent list or live status event supplies that baseline.
          'idle',
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
