import type { SessionHistoryEvent } from '@dsh-vscode/domain'

type DeltaEvent = Extract<
  SessionHistoryEvent['event'],
  { readonly type: 'message.delta' | 'reasoning.delta' }
>

/** Build once per merge; coverage belongs to a message and a delta family. */
export function createHistoryCompactionIndex(
  history: readonly SessionHistoryEvent[],
): (entry: SessionHistoryEvent) => boolean {
  const covered = new Map<DeltaEvent['type'], Map<string, Set<number>>>()
  for (const entry of history) {
    const sequences = entry.coveredSequences
    const event = entry.event
    if (sequences === undefined || sequences.length <= 1 || !isDelta(event)) continue
    let messages = covered.get(event.type)
    if (messages === undefined) {
      messages = new Map()
      covered.set(event.type, messages)
    }
    let positions = messages.get(event.messageId)
    if (positions === undefined) {
      positions = new Set()
      messages.set(event.messageId, positions)
    }
    for (const sequence of sequences) positions.add(sequence)
  }
  return (entry) =>
    entry.coveredSequences === undefined &&
    isDelta(entry.event) &&
    covered.get(entry.event.type)?.get(entry.event.messageId)?.has(entry.sequence) === true
}

function isDelta(event: SessionHistoryEvent['event']): event is DeltaEvent {
  return event.type === 'message.delta' || event.type === 'reasoning.delta'
}
