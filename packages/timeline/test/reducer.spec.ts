import { describe, expect, it } from 'vitest'
import type { BackendEvent } from '@dsh-vscode/domain'
import { reduceTimeline } from '../src/reducer.js'
import type { TimelineState } from '../src/nodes.js'

const initial: TimelineState = { sessionId: 'session-1', nodes: [], lastSequence: -1 }

describe('reduceTimeline', () => {
  it('appends ordered message deltas to the stable message node', () => {
    const first = reduceTimeline(initial, {
      sequence: 1,
      event: { type: 'message.delta', sessionId: 'session-1', messageId: 'm1', delta: 'Hello' },
    })
    const second = reduceTimeline(first, {
      sequence: 2,
      event: { type: 'message.delta', sessionId: 'session-1', messageId: 'm1', delta: ' world' },
    })
    expect(second.nodes).toEqual([
      { kind: 'assistant-message', id: 'm1', markdown: 'Hello world', streaming: true },
    ])
  })

  it('ignores duplicate and stale event sequence numbers', () => {
    const event: BackendEvent = {
      type: 'message.delta',
      sessionId: 'session-1',
      messageId: 'm1',
      delta: 'once',
    }
    const first = reduceTimeline(initial, { sequence: 4, event })
    expect(reduceTimeline(first, { sequence: 4, event })).toBe(first)
    expect(reduceTimeline(first, { sequence: 3, event })).toBe(first)
  })

  it('upserts tool calls, goals, jobs, and subagents by stable id', () => {
    const tool = {
      id: 'tool-1',
      name: 'read',
      category: 'filesystem',
      title: 'Read',
      status: 'running' as const,
      metadata: {},
    }
    const one = reduceTimeline(initial, {
      sequence: 1,
      event: { type: 'tool.updated', sessionId: 'session-1', tool },
    })
    const two = reduceTimeline(one, {
      sequence: 2,
      event: { type: 'tool.updated', sessionId: 'session-1', tool: { ...tool, status: 'completed' } },
    })
    expect(two.nodes).toHaveLength(1)
    expect(two.nodes[0]).toMatchObject({ kind: 'tool', tool: { status: 'completed' } })
  })

  it('replays the same event log to the same immutable state', () => {
    const events = [
      {
        sequence: 1,
        event: { type: 'message.delta', sessionId: 'session-1', messageId: 'm1', delta: 'a' } as BackendEvent,
      },
      {
        sequence: 2,
        event: { type: 'message.completed', sessionId: 'session-1', messageId: 'm1' } as BackendEvent,
      },
      {
        sequence: 3,
        event: { type: 'notice', sessionId: 'session-1', level: 'info', text: 'done' } as BackendEvent,
      },
    ]
    const replay = (state: TimelineState): TimelineState =>
      events.reduce((next, item) => reduceTimeline(next, item), state)
    expect(replay(initial)).toEqual(replay(initial))
  })

  it('hides command lifecycle start notices when the completed result follows', () => {
    const next = reduceTimeline(initial, {
      sequence: 1,
      event: { type: 'notice', sessionId: 'session-1', level: 'info', text: 'permission started.' },
    })
    const completed = reduceTimeline(next, {
      sequence: 2,
      event: {
        type: 'notice',
        sessionId: 'session-1',
        level: 'info',
        text: 'Permission changed to Full access.',
      },
    })
    expect(next.nodes).toEqual([])
    expect(completed.nodes).toMatchObject([{ kind: 'notice', text: 'Permission changed to Full access.' }])
  })

  it('handles unknown rc6 events without losing later known events', () => {
    const unknown = reduceTimeline(initial, {
      sequence: 1,
      event: { type: 'unknown', name: 'future/event', payload: {} },
    })
    const known = reduceTimeline(unknown, {
      sequence: 2,
      event: { type: 'message.delta', sessionId: 'session-1', messageId: 'm1', delta: 'after' },
    })
    expect(known.nodes).toHaveLength(2)
    expect(known.nodes[1]).toMatchObject({ id: 'm1' })
  })
})
