import { describe, expect, it } from 'vitest'

import { domainEvent, parseHostDomainEvent, timelineSequenceOptions } from './event-parser.js'

/**
 * Direct characterization tests for the host payload -> BackendEvent parser.
 * The store integration specs cover downstream behavior; these pin each
 * branch's accept/reject decision so a file split cannot silently loosen or
 * tighten one branch's validation.
 */
describe('domainEvent', () => {
  it('preserves a non-object payload as an unknown row instead of dropping it', () => {
    expect(domainEvent('session.status', 'nope')).toMatchObject({ type: 'unknown', name: 'session.status' })
    expect(domainEvent('session.status', undefined)).toMatchObject({
      type: 'unknown',
      name: 'session.status',
    })
  })

  it('falls back to unknown without consuming the sequence when the sequence is not finite-safe', () => {
    const event = domainEvent('session.status', {
      sequence: Number.NaN,
      sessionId: 's1',
      status: 'running',
    })
    expect(event).toMatchObject({ type: 'unknown', name: 'session.status' })
    expect(event?.sequence).toBeUndefined()
  })

  it('attaches a finite event sequence to an accepted event', () => {
    const event = domainEvent('session.status', { sequence: 7, sessionId: 's1', status: 'running' })
    expect(event).toMatchObject({ type: 'session.status', sessionId: 's1', status: 'running', sequence: 7 })
  })

  const accepted: readonly {
    readonly name: string
    readonly payload: Record<string, unknown>
    readonly expect: Record<string, unknown>
  }[] = [
    { name: 'session.system', payload: { sessionId: 's1' }, expect: { type: 'session.system' } },
    {
      name: 'message.user',
      payload: { sessionId: 's1', messageId: 'm1', markdown: 'hi' },
      expect: { type: 'message.user', markdown: 'hi' },
    },
    {
      name: 'turn.started',
      payload: { sessionId: 's1', turn: 1 },
      expect: { type: 'turn.started', turn: 1 },
    },
    {
      name: 'turn.ended',
      payload: { sessionId: 's1', turn: 1, reason: 'completed' },
      expect: { type: 'turn.ended', reason: 'completed' },
    },
    {
      name: 'turn.ended',
      payload: { sessionId: 's1', turn: 1, reason: 'error', failure: { message: 'boom' } },
      expect: { type: 'turn.ended', reason: 'error' },
    },
    {
      name: 'step.started',
      payload: { sessionId: 's1', turn: 1, step: 2 },
      expect: { type: 'step.started', step: 2 },
    },
    {
      name: 'step.ended',
      payload: { sessionId: 's1', turn: 1, step: 2, time: 5 },
      expect: { type: 'step.ended', time: 5 },
    },
    {
      name: 'message.delta',
      payload: { sessionId: 's1', messageId: 'm1', delta: 'abc', turn: 1, step: 2 },
      expect: { type: 'message.delta', delta: 'abc', turn: 1, step: 2 },
    },
    {
      name: 'reasoning.delta',
      payload: { sessionId: 's1', messageId: 'm1', delta: 'think' },
      expect: { type: 'reasoning.delta', delta: 'think' },
    },
    {
      name: 'message.completed',
      payload: { sessionId: 's1', messageId: 'm1', markdown: 'done', turn: 1, step: 2 },
      expect: { type: 'message.completed', markdown: 'done' },
    },
    {
      name: 'assistant.attempt',
      payload: { sessionId: 's1', turn: 1, step: 2 },
      expect: { type: 'assistant.attempt', turn: 1, step: 2 },
    },
    {
      name: 'session.status',
      payload: { sessionId: 's1', status: 'running' },
      expect: { type: 'session.status', status: 'running' },
    },
    {
      name: 'session.activity',
      payload: { sessionId: 's1', updatedAt: 3 },
      expect: { type: 'session.activity', updatedAt: 3 },
    },
    {
      name: 'session.subscribed',
      payload: { sessionId: 's1', lastSequence: -1 },
      expect: { type: 'session.subscribed', lastSequence: -1 },
    },
    { name: 'session.title', payload: { sessionId: 's1', title: 't' }, expect: { type: 'session.title' } },
    { name: 'session.removed', payload: { sessionId: 's1' }, expect: { type: 'session.removed' } },
    {
      name: 'session.projection.baseline',
      payload: { projections: {} },
      expect: { type: 'session.projection.baseline' },
    },
    {
      name: 'session.projection',
      payload: { sessionId: 's1', key: 'k', value: 1 },
      expect: { type: 'session.projection', key: 'k', value: 1 },
    },
    {
      name: 'session.added',
      payload: { sessionId: 's1', blank: true },
      expect: { type: 'session.added', blank: true },
    },
    {
      name: 'tool.updated',
      payload: {
        sessionId: 's1',
        tool: { id: 'tool-1', name: 'bash', status: 'completed' },
      },
      expect: { type: 'tool.updated' },
    },
    {
      name: 'compaction.updated',
      payload: { sessionId: 's1', compaction: { id: 'c1', phase: 'start' } },
      expect: { type: 'compaction.updated' },
    },
    {
      name: 'model.retry',
      payload: {
        retry: { sessionId: 's1', id: 'r1', turn: 1, step: 1, attempt: 1, state: 'scheduled' },
      },
      expect: { type: 'model.retry' },
    },
    { name: 'jobs.updated', payload: { sessionId: 's1', jobs: [] }, expect: { type: 'jobs.updated' } },
    {
      name: 'workflow.member.ended',
      payload: { sessionId: 's1', runId: 'w1', seq: 1, outcome: 'completed' },
      expect: { type: 'workflow.member.ended', outcome: 'completed' },
    },
    {
      name: 'workflow.ended',
      payload: { sessionId: 's1', runId: 'w1', stopReason: 'completed' },
      expect: { type: 'workflow.ended', stopReason: 'completed' },
    },
    {
      name: 'permission.resolved',
      payload: { sessionId: 's1', requestId: 'p1' },
      expect: { type: 'permission.resolved', requestId: 'p1' },
    },
    {
      name: 'question.resolved',
      payload: { sessionId: 's1', questionRpcId: 'q1' },
      expect: { type: 'question.resolved', questionRpcId: 'q1' },
    },
    { name: 'workspace.changed', payload: {}, expect: { type: 'workspace.changed' } },
    {
      name: 'workspace.changed',
      payload: { workspaceId: 'w1' },
      expect: { type: 'workspace.changed', workspaceId: 'w1' },
    },
    { name: 'workspace.removed', payload: {}, expect: { type: 'workspace.removed' } },
    {
      name: 'workspace.order.changed',
      payload: { workspaceIds: ['w1'] },
      expect: { type: 'workspace.order.changed' },
    },
    {
      name: 'archived.sessions.changed',
      payload: { sessionIds: [] },
      expect: { type: 'archived.sessions.changed' },
    },
    {
      name: 'session.gap',
      payload: { sessionId: 's1', fromSequence: 2, toSequence: 4 },
      expect: { type: 'session.gap', fromSequence: 2, toSequence: 4 },
    },
    {
      name: 'remote.event',
      payload: { name: 'messageFeedback/list', args: [] },
      expect: { type: 'remote.event' },
    },
    {
      name: 'notice',
      payload: { level: 'warning', text: 'watch out' },
      expect: { type: 'notice', level: 'warning', text: 'watch out' },
    },
    {
      name: 'connection.lost',
      payload: { reason: 'socket closed' },
      expect: { type: 'connection.lost', reason: 'socket closed' },
    },
    {
      name: 'unknown',
      payload: { name: 'mystery', payload: { x: 1 } },
      expect: { type: 'unknown', name: 'mystery' },
    },
  ]

  it.each(accepted)('accepts $name -> $expect.type', ({ name, payload, expect: expected }) => {
    const event = domainEvent(name, payload)
    expect(event).toBeDefined()
    expect(event).toMatchObject(expected)
  })

  it('keeps a deliverables row whose files cannot be parsed as unknown', () => {
    const event = domainEvent('deliverables.presented', { sessionId: 's1', turn: 1, callId: 'c1', files: [] })
    expect(event).toMatchObject({ type: 'unknown', name: 'deliverables.presented' })
  })

  it('falls back to a preserved unknown row for a name this build does not interpret', () => {
    expect(domainEvent('totally.unheard', { sessionId: 's1' })).toMatchObject({
      type: 'unknown',
      name: 'totally.unheard',
      sessionId: 's1',
    })
  })

  it('maps an uninterpretable payload onto unknown instead of dropping it for named branches', () => {
    expect(domainEvent('message.delta', { sessionId: 's1', messageId: 'm1', delta: 5 })).toMatchObject({
      type: 'unknown',
      name: 'message.delta',
    })
    expect(domainEvent('turn.started', { sessionId: 's1', turn: 'x' })).toMatchObject({
      type: 'unknown',
      name: 'turn.started',
    })
    expect(
      domainEvent('tool.updated', { sessionId: 's1', tool: { id: '  ', name: 'bash', status: 'completed' } }),
    ).toMatchObject({
      type: 'unknown',
      name: 'tool.updated',
    })
    expect(
      domainEvent('session.subscribed', { sessionId: 's1', lastSequence: 0, controlBaseline: 'yes' }),
    ).toMatchObject({ type: 'unknown', name: 'session.subscribed' })
    expect(domainEvent('workspace.changed', { workspaceId: '  ' })).toMatchObject({
      type: 'unknown',
      name: 'workspace.changed',
    })
    expect(domainEvent('notice', { level: 'loud', text: 'x' })).toMatchObject({
      type: 'unknown',
      name: 'notice',
    })
  })

  it('drops malformed queue asOfSequence instead of projecting an unknown row', () => {
    expect(domainEvent('queue.updated', { sessionId: 's1', items: [], asOfSequence: -3 })).toBeUndefined()
  })
})

describe('parseHostDomainEvent', () => {
  it('passes non-event host messages through as undefined', () => {
    expect(parseHostDomainEvent({ type: 'response' } as never)).toBeUndefined()
  })

  it('returns undefined (not null) for host-internal events the store handles elsewhere', () => {
    for (const name of [
      'runtime.update.progress',
      'ui.sessions.toggle',
      'ui.settings.toggle',
      'connection.snapshot',
    ])
      expect(parseHostDomainEvent({ type: 'event', sequence: 1, name, payload: {} })).toBeUndefined()
  })

  it('maps an uninterpretable event frame to a preserved unknown row', () => {
    expect(
      parseHostDomainEvent({ type: 'event', sequence: 1, name: 'totally.unheard', payload: {} }),
    ).toMatchObject({
      type: 'unknown',
      name: 'totally.unheard',
    })
  })

  it('returns the parsed event for durable frames', () => {
    expect(
      parseHostDomainEvent({
        type: 'event',
        sequence: 1,
        name: 'session.status',
        payload: { sessionId: 's1', status: 'idle' },
      }),
    ).toMatchObject({ type: 'session.status', status: 'idle' })
  })
})

describe('timelineSequenceOptions', () => {
  it('advances the cursor for durable conversation events', () => {
    const event = domainEvent('message.completed', {
      sequence: 3,
      sessionId: 's1',
      messageId: 'm1',
      markdown: 'done',
    })
    expect(event).toBeDefined()
    expect(timelineSequenceOptions(event!)).toEqual({})
  })

  it('does not advance the cursor for session-level state events', () => {
    for (const payload of [
      { sequence: 1, sessionId: 's1', status: 'idle' },
      { sequence: 2, sessionId: 's1' },
      { sequence: 3, sessionId: 's1', jobs: [] },
    ]) {
      const event = domainEvent(
        payload.jobs !== undefined
          ? 'jobs.updated'
          : payload.status !== undefined
            ? 'session.status'
            : 'session.removed',
        payload,
      )
      expect(event).toBeDefined()
      expect(timelineSequenceOptions(event!)).toEqual({ advanceSequence: false })
    }
  })

  it('does not advance the cursor for transient deltas even when they carry a sequence', () => {
    const event = domainEvent('message.delta', {
      sequence: 4,
      sessionId: 's1',
      messageId: 'm1',
      delta: 'x',
      transientSequence: 9,
      transientAttemptId: 'a1',
      transientIndex: 0,
    })
    expect(event).toMatchObject({ type: 'message.delta', transientSequence: 9 })
    expect(timelineSequenceOptions(event!)).toEqual({ advanceSequence: false })
  })

  it('does not advance the cursor for a host-only interrupted completion', () => {
    const event = domainEvent('message.completed', {
      sessionId: 's1',
      messageId: 'm1',
      interrupted: true,
    })
    expect(event).toMatchObject({ type: 'message.completed', interrupted: true })
    expect(event?.sequence).toBeUndefined()
    expect(timelineSequenceOptions(event!)).toEqual({ advanceSequence: false })
  })

  it('never spends a cursor slot on an unknown frame', () => {
    const event = domainEvent('unknown', { sequence: 5, name: 'mystery', payload: {} })
    expect(event).toMatchObject({ type: 'unknown' })
    expect(timelineSequenceOptions(event!)).toEqual({ advanceSequence: false })
  })
})
