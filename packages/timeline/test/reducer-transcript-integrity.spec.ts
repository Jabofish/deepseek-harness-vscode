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

  it('settles the same way when the call merges in after its result', () => {
    const result = withTool(initial, 1, shellResult())
    const both = withTool(result, 2, shellCall({ status: 'completed' }))
    expect(rowOf(both)?.presentation).toEqual({
      phase: 'result',
      card: 'terminal',
      output: 'boom',
      exitCode: 2,
    })
  })

  it('leaves a settled row alone once its card is the settled one', () => {
    const settled = settledRow(shellResult())
    const again = withTool(withTool(withTool(initial, 1, shellCall()), 2, shellResult()), 3, shellResult())
    expect(rowOf(again)?.presentation).toEqual(settled?.presentation)
  })

  it('keeps the running card while the row has not settled, and when no text arrived', () => {
    const runningCard = {
      phase: 'call',
      card: 'terminal',
      title: 'pnpm check',
      description: 'Run the checks',
    }
    const unsettled = { ...shellResult({ status: 'running' }) }
    delete unsettled.outputSummary
    expect(settledRow(unsettled)?.presentation).toEqual(runningCard)

    // A settled row with no text at all has nothing better to state than the
    // command it ran.
    const withoutText = { ...shellResult() }
    delete withoutText.outputSummary
    expect(settledRow(withoutText)?.presentation).toEqual(runningCard)

    // The renderer writes `(no output)` for a silent command, so empty text is
    // not a rendered result: the row falls back instead of inventing a status.
    const empty = settledRow(shellResult({ outputSummary: '' }))
    expect(empty !== undefined && Object.hasOwn(empty, 'presentation')).toBe(false)
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

  it('falls back to the generic row for a persistent shell, a failure and a background call', () => {
    const persistent = settledRow(
      shellResult({
        inputSummary: JSON.stringify({ command: 'pwd' }),
        outputSummary: 'a directory',
      }),
    )
    expect(persistent !== undefined && Object.hasOwn(persistent, 'presentation')).toBe(false)

    const failed = settledRow(
      shellResult({ outputSummary: 'command not found', error: 'command not found', status: 'failed' }),
    )
    expect(failed !== undefined && Object.hasOwn(failed, 'presentation')).toBe(false)
    expect(failed?.error).toBe('command not found')

    const background = settledRow(
      shellResult({
        inputSummary: JSON.stringify({
          command: 'pnpm check',
          description: 'Run the checks',
          run_in_background: true,
        }),
        outputSummary: 'job-1 started',
      }),
    )
    // The call card was never drawn for a background call; the row keeps the
    // identity it has rather than gaining an invented exit status.
    expect(background !== undefined && Object.hasOwn(background, 'presentation')).toBe(false)
  })

  it('keeps a card another producer stated', () => {
    const hostCard = { phase: 'result', card: 'generic', content: ['rendered by the host'] } as const
    const row = settledRow(shellResult({ presentation: hostCard }))
    expect(row?.presentation).toEqual(hostCard)
  })

  it('states a terminal_send result as output alone', () => {
    const send = tool('call-send', 'running', {
      name: 'terminal_send',
      category: 'terminal_send',
      title: 'terminal_send',
      inputSummary: JSON.stringify({ sessionId: 'pty-3', text: 'make' }),
      presentation: { phase: 'call', card: 'terminal', title: 'make', description: 'Terminal pty-3' },
    })
    const row = rowOf(
      withTool(
        withTool(initial, 1, send),
        2,
        tool('call-send', 'completed', {
          name: 'unknown-tool',
          category: 'tool',
          title: 'Tool',
          outputSummary: 'compiling',
        }),
      ),
    )
    expect(row?.presentation).toEqual({
      phase: 'result',
      card: 'terminal',
      output: 'compiling',
    })
  })
})
