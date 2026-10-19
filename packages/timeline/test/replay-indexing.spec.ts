import { describe, expect, it } from 'vitest'
import { reduceTimeline, reduceTimelineBatch, type SequencedBackendEvent } from '../src/reducer.js'
import type { TimelineNode, TimelineState } from '../src/nodes.js'

const initial: TimelineState = { sessionId: 'session', nodes: [], lastSequence: 0 }

describe('indexed private history replay', () => {
  it('reindexes after preview removal and out-of-order host notices without advancing a foreign session', () => {
    const events: readonly SequencedBackendEvent[] = [
      {
        sequence: 1,
        event: { type: 'message.user', sessionId: 'session', messageId: 'user', markdown: 'fixture' },
      },
      {
        sequence: 2,
        event: {
          type: 'tool.preparing',
          sessionId: 'session',
          callId: 'preview',
          toolName: 'fixture',
          turn: 1,
          step: 0,
          attemptId: 'first-attempt',
          updateIndex: 1,
        },
      },
      {
        sequence: 3,
        event: {
          type: 'message.delta',
          sessionId: 'session',
          messageId: 'answer',
          turn: 1,
          step: 0,
          delta: 'first',
          transientAttemptId: 'next-attempt',
          transientIndex: 1,
        },
      },
      {
        sequence: 4,
        event: { type: 'message.completed', sessionId: 'foreign', messageId: 'foreign', markdown: 'foreign' },
      },
      {
        sequence: 2,
        advanceSequence: false,
        event: { type: 'unknown', sessionId: 'session', name: 'late-notice', payload: { kind: 'fixture' } },
      },
      {
        sequence: 5,
        event: {
          type: 'message.completed',
          sessionId: 'session',
          messageId: 'answer',
          turn: 1,
          step: 0,
          markdown: 'settled',
        },
      },
      {
        sequence: 6,
        event: { type: 'message.user', sessionId: 'session', messageId: 'user', markdown: 'updated' },
      },
    ]
    const sequential = events.reduce((current, input) => reduceTimeline(current, input), initial)
    const batch = reduceTimelineBatch(initial, events)
    expect({ ...batch, nodeChangeBase: undefined }).toEqual({ ...sequential, nodeChangeBase: undefined })
    expect(batch.nodes.some((node) => node.id === 'foreign' || node.kind === 'tool')).toBe(false)
    expect(batch.nodes.find((node) => node.id === 'user')).toMatchObject({ markdown: 'updated' })
  })

  it('does not repeatedly search all old rows for newly appended durable messages', () => {
    let idReads = 0
    const nodes: readonly TimelineNode[] = Array.from({ length: 32 }, (_, index) => ({
      kind: 'user-message',
      markdown: 'fixture',
      get id(): string {
        idReads += 1
        return `old-${index}`
      },
    }))
    const inputs: readonly SequencedBackendEvent[] = Array.from({ length: 8 }, (_, index) => ({
      sequence: index + 1,
      event: { type: 'message.user', sessionId: 'session', messageId: `new-${index}`, markdown: 'fixture' },
    }))
    const replayed = reduceTimelineBatch({ ...initial, nodes }, inputs)
    expect(replayed.nodes).toHaveLength(40)
    expect(nodes).toHaveLength(32)
    expect(idReads).toBeLessThan(128)
  })

  it('matches immutable live reduction through duplicate IDs, optimistic previews, replacement and insertion', () => {
    const state: TimelineState = {
      ...initial,
      nodes: [
        { kind: 'user-message', id: 'duplicate', markdown: 'older' },
        { kind: 'user-message', id: 'duplicate', markdown: 'newer' },
        { kind: 'user-message', id: 'optimistic:user:one', markdown: 'same' },
        { kind: 'user-message', id: 'optimistic:user:two', markdown: 'same' },
      ],
    }
    const events: readonly SequencedBackendEvent[] = [
      {
        sequence: 1,
        event: { type: 'message.user', sessionId: 'session', messageId: 'one', markdown: 'same' },
      },
      {
        sequence: 2,
        event: { type: 'message.user', sessionId: 'session', messageId: 'two', markdown: 'same' },
      },
      {
        sequence: 3,
        event: { type: 'message.user', sessionId: 'session', messageId: 'duplicate', markdown: 'updated' },
      },
      {
        sequence: 4,
        event: {
          type: 'reasoning.delta',
          sessionId: 'session',
          messageId: 'preview',
          turn: 1,
          step: 0,
          delta: 'thinking',
        },
      },
      {
        sequence: 5,
        event: {
          type: 'message.completed',
          sessionId: 'session',
          messageId: 'settled',
          turn: 1,
          step: 0,
          markdown: 'answer',
        },
      },
      {
        sequence: 6,
        event: {
          type: 'message.completed',
          sessionId: 'session',
          messageId: 'settled',
          markdown: 'authoritative',
        },
      },
      {
        sequence: 7,
        event: { type: 'unknown', sessionId: 'session', name: 'fixture', payload: { kind: 'fixture' } },
      },
      {
        sequence: 8,
        event: { type: 'message.user', sessionId: 'session', messageId: 'later', markdown: 'next' },
      },
      { sequence: 9, event: { type: 'connection.lost', reason: 'fixture' } },
      {
        sequence: 10,
        event: { type: 'message.completed', sessionId: 'session', messageId: 'last', markdown: 'last' },
      },
    ]
    const sequential = events.reduce((current, input) => reduceTimeline(current, input), state)
    const batch = reduceTimelineBatch(state, events)
    expect({ ...batch, nodeChangeBase: undefined }).toEqual({ ...sequential, nodeChangeBase: undefined })
    expect(state.nodes[2]?.id).toBe('optimistic:user:one')
  })
})
