import { describe, expect, it } from 'vitest'
import type { BackendEvent } from '@dsh-vscode/domain'
import { reduceTimeline } from '../src/reducer.js'
import type { TimelineState } from '../src/nodes.js'

const initial: TimelineState = { sessionId: 'session-1', nodes: [], lastSequence: -1 }

function tool(
  id: string,
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled',
  overrides: Partial<Extract<BackendEvent, { readonly type: 'tool.updated' }>['tool']> = {},
): Extract<BackendEvent, { readonly type: 'tool.updated' }>['tool'] {
  return {
    id,
    name: 'read',
    category: 'read',
    title: 'Read',
    status,
    metadata: {},
    ...overrides,
  }
}

describe('reduceTimeline transcript integrity', () => {
  it('creates a tool row from a result that arrives without its call', () => {
    const state = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'tool.updated',
        sessionId: 'session-1',
        tool: tool('call-orphan', 'completed', { turn: 1, step: 1, outputSummary: 'file contents' }),
      },
    })

    expect(state.nodes).toHaveLength(1)
    expect(state.nodes[0]).toMatchObject({
      kind: 'tool',
      id: 'call-orphan',
      tool: { status: 'completed', outputSummary: 'file contents' },
    })
  })

  it('keeps the richer card identity when a sparse result update follows', () => {
    const withResult = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'tool.updated',
        sessionId: 'session-1',
        tool: tool('call-sparse', 'completed', { title: 'Read src/index.ts', outputSummary: 'export {}' }),
      },
    })
    const merged = reduceTimeline(withResult, {
      sequence: 2,
      event: {
        type: 'tool.updated',
        sessionId: 'session-1',
        // The pinned mapper falls back to a placeholder when a row omits the
        // card identity; the richer first paint must survive.
        tool: tool('call-sparse', 'completed', {
          name: 'unknown-tool',
          category: 'tool',
          title: 'Tool',
          error: 'permission denied',
        }),
      },
    })

    expect(merged.nodes[0]).toMatchObject({
      kind: 'tool',
      id: 'call-sparse',
      tool: {
        name: 'read',
        category: 'read',
        title: 'Read src/index.ts',
        outputSummary: 'export {}',
        status: 'completed',
        error: 'permission denied',
      },
    })
  })

  it('cancels a still-running tool row when its update lands after the turn ended', () => {
    const open = reduceTimeline(initial, {
      sequence: 1,
      event: { type: 'turn.started', sessionId: 'session-1', turn: 1 },
    })
    const ended = reduceTimeline(open, {
      sequence: 2,
      event: { type: 'turn.ended', sessionId: 'session-1', turn: 1, reason: 'completed' },
    })
    const late = reduceTimeline(ended, {
      sequence: 3,
      event: {
        type: 'tool.updated',
        sessionId: 'session-1',
        tool: tool('call-late', 'running', { turn: 1, step: 1 }),
      },
    })

    expect(late.nodes).toHaveLength(1)
    expect(late.nodes[0]).toMatchObject({
      kind: 'tool',
      id: 'call-late',
      tool: { status: 'cancelled' },
    })
  })

  it('settles the streaming row in place when the durable completion carries a different id', () => {
    const streaming = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        delta: 'partial answer',
        transientSequence: 1,
        transientAttemptId: 'attempt-1',
        transientIndex: 0,
      },
    })
    expect(streaming.nodes[0]).toMatchObject({ id: 'assistant:1:1', streaming: true })

    const settled = reduceTimeline(streaming, {
      sequence: 2,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'aaaaaaaa-1111-4111-8111-111111111111',
        turn: 1,
        step: 1,
        markdown: 'final answer',
      },
    })

    // A ledger rebuild reproduces the durable id, so the live row must adopt it
    // instead of leaving a second synthetic node behind.
    expect(settled.nodes).toHaveLength(1)
    expect(settled.nodes[0]).toMatchObject({
      kind: 'assistant-message',
      id: 'aaaaaaaa-1111-4111-8111-111111111111',
      markdown: 'final answer',
      streaming: false,
    })
  })

  it('keeps two identical consecutive user rows distinct', () => {
    const first = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'message.user',
        sessionId: 'session-1',
        messageId: 'user-1',
        markdown: 'ok',
        source: 'user',
      },
    })
    const second = reduceTimeline(first, {
      sequence: 2,
      event: {
        type: 'message.user',
        sessionId: 'session-1',
        messageId: 'user-2',
        markdown: 'ok',
        source: 'user',
      },
    })

    expect(second.nodes.map((node) => node.id)).toEqual(['user-1', 'user-2'])
  })

  it('only lets the text heuristic consume an optimistic placeholder', () => {
    const optimistic: TimelineState = {
      ...initial,
      nodes: [{ kind: 'user-message', id: 'optimistic:user:7', markdown: 'ok' }],
      lastSequence: 5,
    }
    const echoed = reduceTimeline(optimistic, {
      sequence: 6,
      event: {
        type: 'message.user',
        sessionId: 'session-1',
        messageId: 'user-real-1',
        markdown: 'ok',
        source: 'user',
        rpcId: 'rpc-1',
      },
    })
    expect(echoed.nodes.map((node) => node.id)).toEqual(['user-real-1'])

    // A second identical durable row is a second real message: the preview
    // heuristic must not swallow it.
    const followed = reduceTimeline(echoed, {
      sequence: 7,
      event: {
        type: 'message.user',
        sessionId: 'session-1',
        messageId: 'user-real-2',
        markdown: 'ok',
        source: 'user',
        rpcId: 'rpc-2',
      },
    })
    expect(followed.nodes.map((node) => node.id)).toEqual(['user-real-1', 'user-real-2'])
  })

  // Host-only rows never carry a DSH sequence, so their identity is the Host
  // publication counter. That counter is not part of the durable cursor: the
  // Webview's own replay paths (advisory snapshots, switching back to a
  // session) can hand the same row to the reducer again. A redelivery has to
  // refresh the row in place instead of appending a second copy.
  it('refreshes a redelivered host-only notice instead of appending a duplicate', () => {
    const first = reduceTimeline(initial, {
      sequence: 7,
      event: {
        type: 'notice',
        sessionId: 'session-1',
        level: 'error',
        text: 'The provider rejected the request.',
      },
      advanceSequence: false,
    })
    const redelivered = reduceTimeline(first, {
      sequence: 7,
      event: {
        type: 'notice',
        sessionId: 'session-1',
        level: 'error',
        text: 'The provider rejected the request.',
      },
      advanceSequence: false,
    })

    expect(redelivered.nodes.map((node) => node.id)).toEqual(['notice:7'])
  })

  it('refreshes a redelivered command-input row instead of appending a duplicate', () => {
    const command = {
      type: 'notice' as const,
      sessionId: 'session-1',
      level: 'info' as const,
      text: 'permission started.',
      commandInput: '/permission workspace-write',
    }
    const first = reduceTimeline(initial, { sequence: 9, event: command, advanceSequence: false })
    const redelivered = reduceTimeline(first, { sequence: 9, event: command, advanceSequence: false })

    expect(redelivered.nodes.map((node) => node.id)).toEqual(['command-input:9'])
  })

  it('refreshes a redelivered connection warning instead of appending a duplicate', () => {
    const event: BackendEvent = { type: 'connection.lost', reason: 'The stream closed.' }
    const first = reduceTimeline(initial, { sequence: 4, event, advanceSequence: false })
    const redelivered = reduceTimeline(first, { sequence: 4, event, advanceSequence: false })

    expect(redelivered.nodes.map((node) => node.id)).toEqual(['connection:4'])
  })

  it('refreshes a redelivered gap warning instead of appending a duplicate', () => {
    const event: BackendEvent = {
      type: 'session.gap',
      sessionId: 'session-1',
      fromSequence: 20,
      toSequence: 30,
    }
    const first = reduceTimeline(initial, { sequence: 2, event, advanceSequence: false })
    const redelivered = reduceTimeline(first, { sequence: 2, event, advanceSequence: false })

    expect(redelivered.nodes.map((node) => node.id)).toEqual(['gap:session-1:20:30'])
  })
})
