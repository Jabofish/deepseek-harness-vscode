import { describe, expect, it } from 'vitest'
import type { BackendEvent, ToolCallView } from '@dsh-vscode/domain'
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
})

/**
 * A host without a session tool view states a shell call as raw arguments and
 * its result as raw text. The call card is event-local; settling it is not,
 * because the durable result carries no name and no arguments — the two halves
 * meet only in this merge.
 */
describe('reduceTimeline settled shell cards', () => {
  const shellCall = (
    overrides: Partial<Extract<BackendEvent, { readonly type: 'tool.updated' }>['tool']> = {},
  ): Extract<BackendEvent, { readonly type: 'tool.updated' }>['tool'] =>
    tool('call-bash', 'running', {
      name: 'bash',
      category: 'bash',
      title: 'Bash',
      inputSummary: JSON.stringify({ command: 'pnpm check', description: 'Run the checks' }),
      presentation: {
        phase: 'call',
        card: 'terminal',
        title: 'pnpm check',
        description: 'Run the checks',
      },
      ...overrides,
    })

  const shellResult = (
    overrides: Partial<Extract<BackendEvent, { readonly type: 'tool.updated' }>['tool']> = {},
  ): Extract<BackendEvent, { readonly type: 'tool.updated' }>['tool'] =>
    tool('call-bash', 'completed', {
      name: 'unknown-tool',
      category: 'tool',
      title: 'Tool',
      outputSummary: 'boom\n[exit code: 2]',
      ...overrides,
    })

  const withTool = (
    state: TimelineState,
    sequence: number,
    eventTool: Extract<BackendEvent, { readonly type: 'tool.updated' }>['tool'],
  ): TimelineState =>
    reduceTimeline(state, {
      sequence,
      event: { type: 'tool.updated', sessionId: 'session-1', tool: eventTool },
    })

  const rowOf = (state: TimelineState): ToolCallView | undefined => {
    const node = state.nodes[0]
    return node?.kind === 'tool' ? node.tool : undefined
  }

  const settledRow = (
    eventTool: Extract<BackendEvent, { readonly type: 'tool.updated' }>['tool'],
  ): ToolCallView | undefined => rowOf(withTool(withTool(initial, 1, shellCall()), 2, eventTool))

  it('settles a running shell row with the exit status its own output states', () => {
    const row = settledRow(shellResult())
    expect(row?.presentation).toEqual({ phase: 'result', card: 'terminal', output: 'boom', exitCode: 2 })
    expect(row?.outputSummary).toBe('boom\n[exit code: 2]')
    expect(row?.inputSummary).toBe(JSON.stringify({ command: 'pnpm check', description: 'Run the checks' }))
  })

  it('falls back to the generic row when the settled result cannot state a status', () => {
    const spilled = settledRow(
      shellResult({
        outputSummary:
          'partial\n\n(Omitted 50000 bytes. Full formatted result stored at: /spill/o.txt. Read the file.)',
      }),
    )
    expect(spilled !== undefined && Object.hasOwn(spilled, 'presentation')).toBe(false)
    expect(spilled?.outputSummary).toContain('(Omitted 50000 bytes')
  })

  it('keeps a card another producer stated', () => {
    const hostCard = { phase: 'result', card: 'generic', content: ['rendered by the host'] } as const
    const row = settledRow(shellResult({ presentation: hostCard }))
    expect(row?.presentation).toEqual(hostCard)
  })
})
