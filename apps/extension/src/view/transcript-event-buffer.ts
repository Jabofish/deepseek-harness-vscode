import type { BackendEvent } from '@dsh-vscode/domain'

type TextEvent = Extract<BackendEvent, { type: 'message.delta' | 'reasoning.delta' }>
interface Entry {
  event: BackendEvent
  chunks?: TextEvent[]
  lastTransientSequence?: number | undefined
}

/** A bounded pre-reducer mailbox. Only adjacent, losslessly appendable text merges. */
export class TranscriptEventBuffer {
  private entries: Entry[] = []
  private chars = 0
  private fragments = 0
  public overflowed = false

  public get size(): number {
    return this.entries.length
  }

  public push(event: BackendEvent): boolean {
    if (this.overflowed) return false
    const text = isTextEvent(event) && event.sequence === undefined ? event : undefined
    const previous = this.entries.at(-1)
    const merge =
      text !== undefined &&
      previous !== undefined &&
      isTextEvent(previous.event) &&
      previous.event.sequence === undefined &&
      previous.event.type === text.type &&
      previous.event.sessionId === text.sessionId &&
      previous.event.messageId === text.messageId &&
      previous.event.turn === text.turn &&
      previous.event.step === text.step &&
      previous.event.transientAttemptId === text.transientAttemptId &&
      previous.event.transientStartedAfterSequence === text.transientStartedAfterSequence &&
      previous.event.replayed === text.replayed &&
      previous.event.delta !== '' &&
      text.delta !== '' &&
      (previous.event.time !== undefined || text.time === undefined) &&
      (text.transientIndex === undefined ||
        previous.chunks?.at(-1)?.transientIndex === text.transientIndex - 1) &&
      (text.transientSequence === undefined
        ? previous.lastTransientSequence === undefined
        : previous.lastTransientSequence !== undefined &&
          text.transientSequence === previous.lastTransientSequence + 1)
    const chars = text?.delta.length ?? JSON.stringify(event).length
    if (this.chars + chars > 512 * 1024 || this.fragments >= 4096 || (!merge && this.entries.length >= 256)) {
      this.clear()
      this.overflowed = true
      return false
    }
    this.chars += chars
    this.fragments++
    if (merge && text !== undefined && previous !== undefined && isTextEvent(previous.event)) {
      previous.chunks!.push(text)
      previous.lastTransientSequence = text.transientSequence
    } else
      this.entries.push({
        event,
        ...(text === undefined ? {} : { chunks: [text], lastTransientSequence: text.transientSequence }),
      })
    return true
  }

  public *take(
    canMerge: (first: TextEvent) => boolean = (event) =>
      event.transientAttemptId === undefined || event.transientSequence === 1,
  ): Iterable<BackendEvent> {
    const entries = this.entries
    this.clear()
    for (const { event, chunks } of entries) {
      if (chunks === undefined || !isTextEvent(event)) yield event
      else if (!canMerge(event)) yield* chunks
      else {
        // The first reducer step may create/reset the node and initialize its
        // timing/turn fields. Preserve that boundary before combining appends.
        yield chunks[0]!
        const rest = chunks.slice(1),
          first = rest[0],
          last = rest.at(-1)
        if (first !== undefined)
          yield {
            ...first,
            delta: rest.map((chunk) => chunk.delta).join(''),
            ...(last?.transientIndex === undefined ? {} : { transientIndex: last.transientIndex }),
          }
      }
    }
  }

  public clear(): void {
    this.entries = []
    this.chars = 0
    this.fragments = 0
    this.overflowed = false
  }
}

export function isTextEvent(event: BackendEvent): event is TextEvent {
  return event.type === 'message.delta' || event.type === 'reasoning.delta'
}
