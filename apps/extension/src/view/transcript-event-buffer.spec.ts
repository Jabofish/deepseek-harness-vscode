import { describe, expect, it } from 'vitest'
import type { BackendEvent } from '@dsh-vscode/domain'
import { reduceTimeline, type TimelineState } from '@dsh-vscode/timeline'
import { TranscriptEventBuffer } from './transcript-event-buffer.js'

const empty = (): TimelineState => ({ sessionId: 's', nodes: [], lastSequence: 0 })
const apply = (events: Iterable<BackendEvent>, state = empty()): TimelineState => {
  for (const event of events)
    state = reduceTimeline(state, { event, sequence: event.sequence ?? 0, advanceSequence: false })
  return state
}
const delta = (index: number): Extract<BackendEvent, { type: 'message.delta' }> => ({
  type: 'message.delta',
  sessionId: 's',
  messageId: 'm',
  delta: `${index} `,
  transientAttemptId: 'attempt',
  transientSequence: index + 1,
  transientIndex: index,
  transientStartedAfterSequence: 0,
  turn: 1,
  step: 1,
  time: 1000,
})

describe('pre-reducer transcript mailbox', () => {
  it('losslessly combines a thousand transient chunks, including a replay baseline restart', () => {
    const events = Array.from({ length: 1000 }, (_, index) => delta(index))
    const previous = apply([delta(0), delta(1), delta(2)])
    const buffer = new TranscriptEventBuffer()
    for (const event of events) expect(buffer.push(event)).toBe(true)
    expect(buffer.size).toBe(1)
    const combined = [...buffer.take()]
    expect(combined).toHaveLength(2)
    expect(apply(combined).nodes).toEqual(apply(events).nodes)
    expect(apply(combined, previous).nodes).toEqual(apply(events, previous).nodes)
    expect(buffer.size).toBe(0)
  })

  it('preserves duplicate, missing-index, empty and durable frame boundaries', () => {
    const events: BackendEvent[] = [
      delta(0),
      delta(1),
      delta(1),
      delta(3),
      { ...delta(4), type: 'reasoning.delta' },
      { ...delta(5), delta: '' },
      delta(6),
      delta(7),
      { type: 'message.completed', sessionId: 's', messageId: 'm', markdown: 'authoritative', sequence: 1 },
    ]
    const buffer = new TranscriptEventBuffer()
    for (const event of events) buffer.push(event)
    expect(apply(buffer.take()).nodes).toEqual(apply(events).nodes)
  })

  it('keeps partially duplicated groups separate when the resident cursor overlaps', () => {
    const previous = apply([delta(0), delta(1), delta(2)])
    const buffer = new TranscriptEventBuffer()
    const events = [delta(1), delta(2), delta(3), delta(4)]
    for (const event of events) buffer.push(event)
    expect(
      apply(
        buffer.take(() => false),
        previous,
      ).nodes,
    ).toEqual(apply(events, previous).nodes)
  })

  it('bounds bytes, fragments and non-mergeable events, retaining an explicit recovery marker', () => {
    for (const events of [
      [{ ...delta(0), delta: 'x'.repeat(512 * 1024 + 1) }],
      Array.from({ length: 4097 }, (_, index) => delta(index)),
      Array.from({ length: 257 }, (_, index) => ({ ...delta(index), sequence: index + 1 })),
    ]) {
      const buffer = new TranscriptEventBuffer()
      for (const event of events) buffer.push(event)
      expect(buffer.overflowed).toBe(true)
      expect(buffer.size).toBe(0)
      expect(buffer.push(delta(1))).toBe(false)
      buffer.clear()
      expect(buffer.push(delta(0))).toBe(true)
    }
  })
})
