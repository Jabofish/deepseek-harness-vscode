import type { SessionHistoryEvent, SessionSequenceRange } from '@dsh-vscode/domain'

export function mergeHistory(
  current: readonly SessionHistoryEvent[],
  additions: readonly SessionHistoryEvent[],
): readonly SessionHistoryEvent[] {
  if (additions.length === 0) return current
  let previousSequence = current[current.length - 1]?.sequence
  let appendOnly = true
  for (let index = 1; index < current.length; index += 1) {
    const previous = current[index - 1]?.sequence
    const currentSequence = current[index]?.sequence
    if (previous !== undefined && currentSequence !== undefined && currentSequence < previous) {
      appendOnly = false
      break
    }
  }
  for (const addition of additions) {
    if (!appendOnly) break
    if (previousSequence !== undefined && addition.sequence <= previousSequence) {
      appendOnly = false
      break
    }
    previousSequence = addition.sequence
  }
  // Live stream frames are monotonic in the durable DSH sequence space. Keep
  // the common path linear in the new entries; older-page merges and replay
  // races still use the deduplicating sorted path below.
  if (appendOnly) return current.concat(additions)

  // A durable sequence identifies the upstream log position, not a whole
  // history batch. Projection records intentionally share one sequence, and
  // replay races can also present the same sequence with a distinct event.
  // Indexing only by sequence silently discarded those records and was the
  // source of missing state in complex multi-tool streams. Deduplicate only
  // exact logical event replays, then keep every distinct same-sequence row.
  const byIdentity = new Map<string, SessionHistoryEvent>()
  for (const entry of [...current, ...additions]) {
    const identity = historyEntryIdentity(entry)
    const existing = byIdentity.get(identity)
    if (existing === undefined) byIdentity.set(identity, entry)
    else byIdentity.set(identity, mergeHistoryCoverage(existing, entry))
  }
  const unique = [...byIdentity.values()]
  return unique
    .filter((entry) => !isDeltaCoveredByCompactedEntry(entry, unique))
    .sort((left, right) => left.sequence - right.sequence)
}

function historyEntryIdentity(entry: SessionHistoryEvent): string {
  try {
    return `${entry.sequence}:${JSON.stringify(entry.event)}`
  } catch {
    // Parsed DSH payloads are acyclic, but retain a deterministic fallback if
    // a future adapter event carries a non-serializable extension value.
    return `${entry.sequence}:${entry.event.type}`
  }
}

function mergeHistoryCoverage(left: SessionHistoryEvent, right: SessionHistoryEvent): SessionHistoryEvent {
  const coveredSequences = [
    ...new Set([...(left.coveredSequences ?? []), ...(right.coveredSequences ?? [])]),
  ].sort((first, second) => first - second)
  return coveredSequences.length === 0 ? left : { ...left, coveredSequences }
}

export function oldestHistorySequence(history: readonly SessionHistoryEvent[]): number | undefined {
  return history.reduce<number | undefined>((oldest, entry) => {
    const entryOldest = Math.min(entry.sequence, ...(entry.coveredSequences ?? []))
    return oldest === undefined ? entryOldest : Math.min(oldest, entryOldest)
  }, undefined)
}

export function historyCoversSequenceRange(
  history: readonly SessionHistoryEvent[],
  fromSequence: number,
  toSequence: number,
): boolean {
  return sequenceRangesCover(historySequenceRanges(history), fromSequence, toSequence)
}

export function historySequenceRanges(
  history: readonly SessionHistoryEvent[],
): readonly SessionSequenceRange[] {
  const sequences = history.flatMap((entry) => entry.coveredSequences ?? [entry.sequence])
  return mergeSequenceRanges(
    [],
    sequences.map((sequence) => ({ from: sequence, to: sequence })),
  )
}

export function mergeSequenceRanges(
  current: readonly SessionSequenceRange[],
  additions: readonly SessionSequenceRange[],
): readonly SessionSequenceRange[] {
  const ordered = [...current, ...additions].sort(
    (left, right) => left.from - right.from || left.to - right.to,
  )
  const merged: SessionSequenceRange[] = []
  for (const range of ordered) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && range.from <= previous.to + 1) {
      if (range.to > previous.to) merged[merged.length - 1] = { ...previous, to: range.to }
    } else merged.push(range)
  }
  return merged
}

export function sequenceRangesCover(
  ranges: readonly SessionSequenceRange[],
  fromSequence: number,
  toSequence: number,
): boolean {
  if (fromSequence > toSequence) return true
  return ranges.some((range) => range.from <= fromSequence && range.to >= toSequence)
}

function isDeltaCoveredByCompactedEntry(
  entry: SessionHistoryEvent,
  candidates: readonly SessionHistoryEvent[],
): boolean {
  if (entry.coveredSequences !== undefined || !isDeltaHistoryEvent(entry.event)) return false
  return candidates.some(
    (candidate) =>
      candidate.coveredSequences !== undefined &&
      candidate.coveredSequences.length > 1 &&
      isDeltaHistoryEvent(candidate.event) &&
      candidate.event.type === entry.event.type &&
      candidate.event.messageId === entry.event.messageId &&
      candidate.coveredSequences.includes(entry.sequence),
  )
}

function isDeltaHistoryEvent(
  event: SessionHistoryEvent['event'],
): event is Extract<SessionHistoryEvent['event'], { readonly type: 'message.delta' | 'reasoning.delta' }> {
  return event.type === 'message.delta' || event.type === 'reasoning.delta'
}

export function newestHistorySequence(history: readonly SessionHistoryEvent[]): number | undefined {
  return history.reduce<number | undefined>(
    (newest, entry) => (newest === undefined ? entry.sequence : Math.max(newest, entry.sequence)),
    undefined,
  )
}
