import type { SessionHistoryEvent } from '@dsh-vscode/domain'
import { expect, it, vi } from 'vitest'
import { compactHistoryEvents } from '../src/repositories/session/history.js'

function delta(
  sequence: number,
  text = String(sequence),
  type: 'message.delta' | 'reasoning.delta' = 'message.delta',
  coveredSequences?: readonly number[],
): SessionHistoryEvent {
  return Object.freeze({
    sequence,
    time: '2026-01-01T00:00:00.000Z',
    event: Object.freeze({ type, sessionId: 'session', messageId: 'message', delta: text, sequence }),
    ...(coveredSequences === undefined ? {} : { coveredSequences: Object.freeze(coveredSequences) }),
  })
}

it.each(['message.delta', 'reasoning.delta'] as const)(
  'sorts covered sequences once per contiguous %s group',
  (type) => {
    const events = Object.freeze(Array.from({ length: 128 }, (_, index) => delta(index + 1, '.', type)))
    const sort: (this: unknown[], compare?: (left: unknown, right: unknown) => number) => unknown[] =
      Array.prototype.sort
    let sortedElements = 0
    const spy = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: unknown[], compare) {
      sortedElements += this.length
      return sort.call(this, compare)
    })
    let result: readonly SessionHistoryEvent[]
    try {
      result = compactHistoryEvents(events)
    } finally {
      spy.mockRestore()
    }
    expect(sortedElements).toBeLessThanOrEqual(129)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      sequence: 128,
      event: { type, delta: '.'.repeat(128), sequence: 128 },
      coveredSequences: events.map((entry) => entry.sequence),
    })
    expect(events[0]?.event).toMatchObject({ delta: '.', sequence: 1 })
  },
)

it('keeps source text order, unique coverage, watermarks and event boundaries', () => {
  const boundary: SessionHistoryEvent = Object.freeze({
    sequence: 5,
    time: '2026-01-01T00:00:00.000Z',
    event: Object.freeze({ type: 'unknown', name: 'tool/boundary', payload: null }),
  })
  const singleton = delta(6, 'last')
  const result = compactHistoryEvents([
    delta(4, 'first', 'message.delta', [4, 2]),
    delta(3, 'second', 'message.delta', [3, 2]),
    boundary,
    delta(5, 'reason', 'reasoning.delta'),
    singleton,
  ])
  expect(result.map((entry) => entry.sequence)).toEqual([4, 5, 5, 6])
  expect(result[0]).toMatchObject({
    event: { delta: 'firstsecond', sequence: 4 },
    coveredSequences: [2, 3, 4],
  })
  expect(result[1]).toBe(boundary)
  expect(result[2]?.event.type).toBe('reasoning.delta')
  expect(result[3]).toBe(singleton)
})

it('does not merge across filtered bookkeeping or authoritative completed messages', () => {
  const completed: SessionHistoryEvent = {
    sequence: 5,
    time: '2026-01-01T00:00:00.000Z',
    event: { type: 'message.completed', sessionId: 'session', messageId: 'done', markdown: 'whole' },
  }
  const result = compactHistoryEvents([
    delta(1, 'before'),
    {
      sequence: 2,
      time: completed.time,
      event: { type: 'unknown', name: 'assistant/chunk/finish', payload: null },
    },
    delta(3, 'after'),
    {
      ...delta(4),
      event: { type: 'message.delta', sessionId: 'session', messageId: 'done', delta: 'duplicate' },
    },
    completed,
  ])
  expect(result.map((entry) => entry.sequence)).toEqual([1, 3, 5])
  expect(result[2]).toBe(completed)
})
