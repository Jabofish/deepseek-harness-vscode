import { describe, expect, it } from 'vitest'
import type { BackendEvent } from '@dsh-vscode/domain'
import { reduceTimeline } from '../src/reducer.js'
import type { TimelineState } from '../src/nodes.js'

const initial: TimelineState = { sessionId: 'session-1', nodes: [], lastSequence: -1 }

describe('reduceTimeline', () => {
  it('adds a visible terminal node for max-token and error turn endings', () => {
    let state = reduceTimeline(initial, {
      sequence: 1,
      event: { type: 'turn.started', sessionId: 'session-1', turn: 7 },
    })
    state = reduceTimeline(state, {
      sequence: 2,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'assistant:7:0',
        turn: 7,
        step: 0,
        markdown: 'partial',
      },
    })
    const maxTokens = reduceTimeline(state, {
      sequence: 3,
      event: { type: 'turn.ended', sessionId: 'session-1', turn: 7, reason: 'max-tokens' },
    })
    expect(maxTokens.nodes).toContainEqual({
      kind: 'turn-terminal',
      id: 'turn-terminal:7',
      turn: 7,
      sequence: 3,
      reason: 'max-tokens',
    })

    const error = reduceTimeline(initial, {
      sequence: 4,
      event: {
        type: 'turn.ended',
        sessionId: 'session-1',
        turn: 8,
        reason: 'error',
        failure: { code: 'PROVIDER_UNAVAILABLE', message: 'The provider is unavailable.' },
      },
    })
    expect(error.nodes).toContainEqual(
      expect.objectContaining({
        reason: 'error',
        turn: 8,
        failure: { code: 'PROVIDER_UNAVAILABLE', message: 'The provider is unavailable.' },
      }),
    )
  })

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

  it('retains durable image references on user and assistant timeline nodes', () => {
    const image = {
      attachmentId: 'fixture:image',
      mediaType: 'image/png' as const,
      bytes: 247,
      width: 160,
      height: 90,
      name: 'fixture-image.png',
    }
    const user = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'message.user',
        sessionId: 'session-1',
        messageId: 'user-1',
        markdown: 'look at this',
        images: [image],
      },
    })
    const assistant = reduceTimeline(user, {
      sequence: 2,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'assistant-1',
        markdown: 'I can see it.',
        images: [image],
      },
    })

    expect(assistant.nodes).toContainEqual(expect.objectContaining({ kind: 'user-message', images: [image] }))
    expect(assistant.nodes).toContainEqual(
      expect.objectContaining({ kind: 'assistant-message', images: [image] }),
    )
  })

  it('retains DSH step start, first-token, and completion timing on an assistant node', () => {
    const started = reduceTimeline(initial, {
      sequence: 1,
      event: { type: 'step.started', sessionId: 'session-1', turn: 1, step: 1, time: 1_000 },
    })
    const streamed = reduceTimeline(started, {
      sequence: 2,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        time: 1_800,
        delta: 'Hello',
      },
    })
    const completed = reduceTimeline(streamed, {
      sequence: 3,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        time: 4_800,
        markdown: 'Hello',
      },
    })

    expect(completed.nodes).toEqual([
      {
        kind: 'assistant-message',
        id: 'assistant:1:1',
        markdown: 'Hello',
        streaming: false,
        sequence: 3,
        turn: 1,
        step: 1,
        timing: { stepStartTime: 1_000, firstTokenTime: 1_800, completedTime: 4_800 },
      },
    ])
    expect(completed.stepTimings).toBeUndefined()
  })

  it('reconciles streamed coordinates with the durable assistant message id', () => {
    const streamed = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        delta: 'Hello',
      },
    })
    const completed = reduceTimeline(streamed, {
      sequence: 2,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'assistant-message-real-1',
        turn: 1,
        step: 1,
        markdown: 'Hello',
      },
    })

    expect(completed.nodes).toEqual([
      {
        kind: 'assistant-message',
        id: 'assistant-message-real-1',
        markdown: 'Hello',
        streaming: false,
        sequence: 2,
        turn: 1,
        step: 1,
      },
    ])
  })

  it('closes an accumulated answer when the terminal completion carries usage only', () => {
    const streamed = reduceTimeline(initial, {
      sequence: 10,
      event: { type: 'message.delta', sessionId: 'session-1', messageId: 'm1', delta: 'answer' },
    })
    const completed = reduceTimeline(streamed, {
      sequence: 11,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'm1',
        usage: { inputTokens: 4, outputTokens: 2 },
      },
    })

    expect(completed.nodes).toEqual([
      {
        kind: 'assistant-message',
        id: 'm1',
        markdown: 'answer',
        streaming: false,
        sequence: 11,
        usage: { inputTokens: 4, outputTokens: 2 },
      },
    ])
  })

  it('keeps a completed step active until turn/end and settles the final answer there', () => {
    let state = reduceTimeline(initial, {
      sequence: 1,
      event: { type: 'turn.started', sessionId: 'session-1', turn: 1 },
    })
    state = reduceTimeline(state, {
      sequence: 2,
      event: { type: 'step.started', sessionId: 'session-1', turn: 1, step: 0 },
    })
    state = reduceTimeline(state, {
      sequence: 3,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'assistant:1:0',
        turn: 1,
        step: 0,
        delta: 'Before tool',
      },
    })
    state = reduceTimeline(state, {
      sequence: 4,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'assistant:1:0',
        turn: 1,
        step: 0,
        markdown: 'Before tool',
      },
    })
    expect(state.activeTurn).toBe(1)
    expect(state.nodes).toContainEqual(expect.objectContaining({ id: 'assistant:1:0', streaming: false }))
    const firstAssistant = state.nodes.find(
      (node) => node.kind === 'assistant-message' && node.id === 'assistant:1:0',
    )
    expect(
      firstAssistant?.kind === 'assistant-message' ? firstAssistant.turnCompleted : undefined,
    ).toBeUndefined()

    state = reduceTimeline(state, {
      sequence: 5,
      event: {
        type: 'tool.updated',
        sessionId: 'session-1',
        tool: {
          id: 'call-1',
          turn: 1,
          step: 0,
          name: 'read',
          category: 'filesystem',
          title: 'Read',
          status: 'completed',
          metadata: {},
        },
      },
    })
    state = reduceTimeline(state, {
      sequence: 6,
      event: { type: 'step.started', sessionId: 'session-1', turn: 1, step: 1 },
    })
    state = reduceTimeline(state, {
      sequence: 7,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        markdown: 'Final answer',
      },
    })
    expect(state.activeTurn).toBe(1)

    const ended = reduceTimeline(state, {
      sequence: 8,
      event: { type: 'turn.ended', sessionId: 'session-1', turn: 1, reason: 'completed' },
    })
    expect(ended.activeTurn).toBeUndefined()
    expect(ended.nodes).toContainEqual(expect.objectContaining({ id: 'assistant:1:0', turnCompleted: false }))
    expect(ended.nodes).toContainEqual(expect.objectContaining({ id: 'assistant:1:1', turnCompleted: true }))
  })

  it('closes an interrupted streamed step at step/end without closing its turn', () => {
    let state = reduceTimeline(initial, {
      sequence: 1,
      event: { type: 'turn.started', sessionId: 'session-1', turn: 2 },
    })
    state = reduceTimeline(state, {
      sequence: 2,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'assistant:2:0',
        turn: 2,
        step: 0,
        delta: 'partial',
      },
    })
    state = reduceTimeline(state, {
      sequence: 3,
      event: { type: 'step.ended', sessionId: 'session-1', turn: 2, step: 0 },
    })
    expect(state.activeTurn).toBe(2)
    expect(state.nodes).toContainEqual(
      expect.objectContaining({ id: 'assistant:2:0', streaming: false, sequence: 3 }),
    )

    const ended = reduceTimeline(state, {
      sequence: 4,
      event: { type: 'turn.ended', sessionId: 'session-1', turn: 2, reason: 'aborted' },
    })
    expect(ended.activeTurn).toBeUndefined()
    expect(ended.nodes).toContainEqual(expect.objectContaining({ id: 'assistant:2:0', turnCompleted: true }))
  })

  it('preserves the rc.8 interrupted-prefix marker on the assistant node', () => {
    const next = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'assistant:1:0',
        markdown: 'partial answer',
        interrupted: true,
      },
    })
    expect(next.nodes).toEqual([
      {
        kind: 'assistant-message',
        id: 'assistant:1:0',
        markdown: 'partial answer',
        streaming: false,
        sequence: 1,
        interrupted: true,
      },
    ])
  })

  it('does not mark an answer branchable when an error or later tool follows it', () => {
    let state = reduceTimeline(initial, {
      sequence: 1,
      event: { type: 'turn.started', sessionId: 'session-1', turn: 3 },
    })
    state = reduceTimeline(state, {
      sequence: 2,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'assistant:3:0',
        turn: 3,
        step: 0,
        markdown: 'Answer',
      },
    })
    state = reduceTimeline(state, {
      sequence: 3,
      event: {
        type: 'tool.updated',
        sessionId: 'session-1',
        tool: {
          id: 'call-after',
          turn: 3,
          step: 1,
          name: 'search',
          category: 'tool',
          title: 'Search',
          status: 'completed',
          metadata: {},
        },
      },
    })
    const toolFollowed = reduceTimeline(state, {
      sequence: 4,
      event: { type: 'turn.ended', sessionId: 'session-1', turn: 3, reason: 'completed' },
    })
    expect(toolFollowed.nodes).toContainEqual(
      expect.objectContaining({ id: 'assistant:3:0', turnCompleted: false }),
    )

    let errorState = reduceTimeline(initial, {
      sequence: 1,
      event: { type: 'turn.started', sessionId: 'session-1', turn: 4 },
    })
    errorState = reduceTimeline(errorState, {
      sequence: 2,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'assistant:4:0',
        turn: 4,
        step: 0,
        markdown: 'Failed after output',
      },
    })
    const errored = reduceTimeline(errorState, {
      sequence: 3,
      event: { type: 'turn.ended', sessionId: 'session-1', turn: 4, reason: 'error' },
    })
    expect(errored.nodes).toContainEqual(
      expect.objectContaining({ id: 'assistant:4:0', turnCompleted: false }),
    )
  })

  it('does not reopen a closed turn when a late tool projection arrives', () => {
    let state = reduceTimeline(initial, {
      sequence: 1,
      event: { type: 'turn.started', sessionId: 'session-1', turn: 5 },
    })
    state = reduceTimeline(state, {
      sequence: 2,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'assistant:5:0',
        turn: 5,
        step: 0,
        markdown: 'Done',
      },
    })
    state = reduceTimeline(state, {
      sequence: 3,
      event: { type: 'turn.ended', sessionId: 'session-1', turn: 5, reason: 'completed' },
    })
    const late = reduceTimeline(state, {
      sequence: 4,
      event: {
        type: 'tool.updated',
        sessionId: 'session-1',
        tool: {
          id: 'late-call',
          turn: 5,
          step: 0,
          name: 'read',
          category: 'tool',
          title: 'Read',
          status: 'running',
          metadata: {},
        },
      },
    })
    expect(late.activeTurn).toBeUndefined()
    expect(late.nodes).toContainEqual(expect.objectContaining({ id: 'assistant:5:0', turnCompleted: false }))
    const lateTool = late.nodes.find((node) => node.kind === 'tool' && node.id === 'late-call')
    expect(lateTool?.kind === 'tool' ? lateTool.tool.status : undefined).toBe('cancelled')
  })

  it('does not let host-only notices consume the durable session cursor', () => {
    const streamed = reduceTimeline(initial, {
      sequence: 10,
      event: { type: 'message.delta', sessionId: 'session-1', messageId: 'm1', delta: 'a' },
    })
    const hostNotice = reduceTimeline(streamed, {
      sequence: 999,
      advanceSequence: false,
      event: { type: 'workspace.changed' },
    })
    const resumed = reduceTimeline(hostNotice, {
      sequence: 11,
      event: { type: 'message.delta', sessionId: 'session-1', messageId: 'm1', delta: 'b' },
    })

    expect(hostNotice.lastSequence).toBe(10)
    expect(resumed.nodes).toContainEqual(
      expect.objectContaining({ id: 'm1', markdown: 'ab', streaming: true }),
    )
    expect(resumed.lastSequence).toBe(11)
  })

  it('does not let a sequenced session projection consume the durable session cursor', () => {
    const streamed = reduceTimeline(initial, {
      sequence: 10,
      event: { type: 'message.delta', sessionId: 'session-1', messageId: 'm1', delta: 'a' },
    })
    const projection = reduceTimeline(streamed, {
      sequence: 999,
      advanceSequence: false,
      event: {
        type: 'session.projection',
        sessionId: 'session-1',
        key: 'sessionStats',
        value: { turns: 1 },
      },
    })
    const resumed = reduceTimeline(projection, {
      sequence: 11,
      event: { type: 'message.delta', sessionId: 'session-1', messageId: 'm1', delta: 'b' },
    })

    expect(projection.lastSequence).toBe(10)
    expect(resumed.nodes).toContainEqual(
      expect.objectContaining({ id: 'm1', markdown: 'ab', streaming: true }),
    )
    expect(resumed.lastSequence).toBe(11)
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

  it('reconciles an optimistic preview with a DSH event-stream rpc id', () => {
    const pending: TimelineState = {
      ...initial,
      nodes: [{ kind: 'user-message', id: 'optimistic:user:webview-1', markdown: 'same prompt' }],
    }
    const actual = reduceTimeline(pending, {
      sequence: 1,
      event: {
        type: 'message.user',
        sessionId: 'session-1',
        messageId: 'message-1',
        markdown: 'same prompt',
        rpcId: 'dsh-frame-1',
        source: 'user',
      },
    })

    expect(actual.nodes).toEqual([
      {
        kind: 'user-message',
        id: 'message-1',
        markdown: 'same prompt',
        rpcId: 'dsh-frame-1',
        source: 'user',
      },
    ])
  })

  it('reconciles a compact text attachment preview without retaining its file body', () => {
    const pending: TimelineState = {
      ...initial,
      nodes: [
        {
          kind: 'user-message',
          id: 'optimistic:user:webview-2',
          markdown: '概括文件内容',
          attachments: [{ name: '思路4.md' }],
        },
      ],
    }
    const actual = reduceTimeline(pending, {
      sequence: 1,
      event: {
        type: 'message.user',
        sessionId: 'session-1',
        messageId: 'message-2',
        markdown: '概括文件内容',
        attachments: [{ name: '思路4.md' }],
      },
    })

    expect(actual.nodes).toEqual([
      {
        kind: 'user-message',
        id: 'message-2',
        markdown: '概括文件内容',
        attachments: [{ name: '思路4.md' }],
      },
    ])
  })

  it('retains producer-owned user messages for Trajectory context projection', () => {
    const next = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'message.user',
        sessionId: 'session-1',
        messageId: 'context-1',
        markdown: 'Injected context that must not become a chat bubble.',
        source: 'plugin',
        sourceForm: 'snapshot',
      },
    })

    expect(next.nodes).toEqual([
      {
        kind: 'user-message',
        id: 'context-1',
        markdown: 'Injected context that must not become a chat bubble.',
        source: 'plugin',
        sourceForm: 'snapshot',
      },
    ])
  })

  it('does not advance the active session cursor for a foreign event', () => {
    const next = reduceTimeline(initial, {
      sequence: 99,
      event: {
        type: 'message.completed',
        sessionId: 'other-session',
        messageId: 'other-answer',
        markdown: 'not for the active session',
      },
    })

    expect(next).toBe(initial)
  })

  it('does not reconcile an attachment preview with a different attachment set', () => {
    const pending: TimelineState = {
      ...initial,
      nodes: [
        {
          kind: 'user-message',
          id: 'optimistic:user:webview-3',
          markdown: 'same prompt',
          attachments: [{ name: 'one.txt', mimeType: 'text/plain' }],
        },
      ],
    }
    const actual = reduceTimeline(pending, {
      sequence: 1,
      event: {
        type: 'message.user',
        sessionId: 'session-1',
        messageId: 'message-3',
        markdown: 'same prompt',
      },
    })

    expect(actual.nodes).toHaveLength(2)
    expect(actual.nodes[0]?.id).toBe('optimistic:user:webview-3')
    expect(actual.nodes[1]?.id).toBe('message-3')
  })

  it('upserts tool calls by stable id', () => {
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

  it('folds durable workflow records by run and exact phase identity', () => {
    const started = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'workflow.started',
        sessionId: 'session-1',
        workflow: {
          id: 'run-1',
          sessionId: 'session-1',
          name: 'audit',
          status: 'running',
          stages: [],
        },
      },
    })
    const withEmptyPhase = reduceTimeline(started, {
      sequence: 2,
      event: {
        type: 'workflow.member.started',
        sessionId: 'session-1',
        runId: 'run-1',
        phase: '',
        member: { seq: 1, label: 'first', childId: 'child-1', status: 'running' },
      },
    })
    const withMissingPhase = reduceTimeline(withEmptyPhase, {
      sequence: 3,
      event: {
        type: 'workflow.member.started',
        sessionId: 'session-1',
        runId: 'run-1',
        phase: null,
        member: { seq: 2, label: 'second', childId: 'child-2', status: 'running' },
      },
    })
    const settledMember = reduceTimeline(withMissingPhase, {
      sequence: 4,
      event: {
        type: 'workflow.member.ended',
        sessionId: 'session-1',
        runId: 'run-1',
        seq: 1,
        outcome: 'completed',
      },
    })
    const ended = reduceTimeline(settledMember, {
      sequence: 5,
      event: {
        type: 'workflow.member.ended',
        sessionId: 'session-1',
        runId: 'run-1',
        seq: 2,
        outcome: 'failed',
      },
    })
    const failed = reduceTimeline(ended, {
      sequence: 6,
      event: {
        type: 'workflow.ended',
        sessionId: 'session-1',
        runId: 'run-1',
        stopReason: 'error',
      },
    })
    expect(failed.nodes).toMatchObject([
      {
        kind: 'workflow',
        workflow: {
          status: 'failed',
          stages: [
            { id: 'value:0:', phase: '', members: [{ seq: 1, status: 'completed' }] },
            { id: 'missing', phase: null, members: [{ seq: 2, status: 'failed' }] },
          ],
        },
      },
    ])
  })

  it('upserts rc.8 Agent Team activity by durable activity identity', () => {
    const member = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'team.updated',
        sessionId: 'session-1',
        activity: {
          kind: 'member',
          id: 'team:member:team-1:member-1',
          teamId: 'team-1',
          memberId: 'member-1',
          name: 'Planner',
          phase: 'provisioning',
        },
      },
    })
    const active = reduceTimeline(member, {
      sequence: 2,
      event: {
        type: 'team.updated',
        sessionId: 'session-1',
        activity: {
          kind: 'member',
          id: 'team:member:team-1:member-1',
          teamId: 'team-1',
          memberId: 'member-1',
          name: 'Planner',
          phase: 'active',
        },
      },
    })
    expect(active.nodes).toHaveLength(1)
    expect(active.nodes[0]).toMatchObject({ kind: 'team', activity: { phase: 'active' } })
  })

  it('keeps transient job snapshots out of the durable timeline', () => {
    const next = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'jobs.updated',
        sessionId: 'session-1',
        jobs: [{ id: 'bash-1', kind: 'bash', label: 'pnpm test', status: 'running', startedAt: 0 }],
      },
    })
    expect(next.nodes).toEqual([])
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

  it('keeps plan and permission switches out of the chat timeline', () => {
    let state = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'notice',
        sessionId: 'session-1',
        level: 'info',
        text: 'permission started.',
        commandId: 'command-1',
        commandPhase: 'run',
        commandName: 'permission',
        commandInput: '/permission read-only',
      },
    })
    state = reduceTimeline(state, {
      sequence: 2,
      event: {
        type: 'notice',
        sessionId: 'session-1',
        level: 'info',
        text: 'Permission changed to Read only.',
        commandId: 'command-1',
        commandPhase: 'done',
        commandName: 'permission',
      },
    })
    state = reduceTimeline(state, {
      sequence: 3,
      event: {
        type: 'notice',
        sessionId: 'session-1',
        level: 'info',
        text: 'Plan mode on.',
        commandId: 'command-2',
        commandPhase: 'run',
        commandName: 'plan',
        commandInput: '/plan',
      },
    })

    expect(state.nodes).toEqual([])
  })

  it('retains mode-switch failures as visible error notices', () => {
    const state = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'notice',
        sessionId: 'session-1',
        level: 'error',
        text: 'The DSH command could not be applied. Details: invalid permission.',
        commandName: 'permission',
        commandInput: '/permission read-only',
      },
    })

    expect(state.nodes).toEqual([
      {
        kind: 'notice',
        id: 'notice:1',
        level: 'error',
        text: 'The DSH command could not be applied. Details: invalid permission.',
      },
    ])
  })

  it('projects structured command/run input before its completion notice', () => {
    const next = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'notice',
        sessionId: 'session-1',
        level: 'info',
        text: 'permission started.',
        commandInput: '/permission workspace-write',
      },
    })
    expect(next.nodes).toEqual([
      { kind: 'command-input', id: 'command-input:1', text: '/permission workspace-write' },
    ])
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

  it('places a late-arriving unknown event before a later durable transcript node', () => {
    const state: TimelineState = {
      sessionId: 'session-1',
      nodes: [
        {
          kind: 'assistant-message',
          id: 'assistant-message-5',
          markdown: 'answer',
          streaming: false,
          sequence: 5,
        },
      ],
      lastSequence: 0,
    }

    const next = reduceTimeline(state, {
      sequence: 3,
      event: { type: 'unknown', name: 'future/event', payload: { source: 'dsh' } },
    })

    expect(next.nodes.map((node) => node.kind)).toEqual(['event', 'assistant-message'])
    expect(next.nodes[0]).toMatchObject({ kind: 'event', sequence: 3, name: 'future/event' })
  })

  it('keeps a producer-correlated retry row and records started/cancelled states', () => {
    const first = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'model.retry',
        retry: {
          sessionId: 'session-1',
          id: 'retry-1',
          turn: 1,
          step: 1,
          attempt: 1,
          state: 'scheduled',
        },
      },
    })
    const second = reduceTimeline(first, {
      sequence: 2,
      event: {
        type: 'model.retry',
        retry: {
          sessionId: 'session-1',
          id: 'retry-1',
          turn: 1,
          step: 1,
          attempt: 1,
          state: 'started',
        },
      },
    })
    expect(second.nodes).toEqual([
      { kind: 'retry', id: 'retry:retry-1', sequence: 2, turn: 1, step: 1, attempt: 1, state: 'started' },
    ])
    const resumed = reduceTimeline(second, {
      sequence: 3,
      event: { type: 'message.delta', sessionId: 'session-1', messageId: 'm1', delta: 'back' },
    })
    expect(resumed.nodes).toEqual([
      { kind: 'retry', id: 'retry:retry-1', sequence: 2, turn: 1, step: 1, attempt: 1, state: 'started' },
      { kind: 'assistant-message', id: 'm1', markdown: 'back', streaming: true },
    ])

    const scheduled = reduceTimeline(resumed, {
      sequence: 4,
      event: {
        type: 'model.retry',
        retry: {
          sessionId: 'session-1',
          id: 'retry-2',
          turn: 1,
          step: 2,
          attempt: 1,
          state: 'scheduled',
          message: 'transport failed',
        },
      },
    })
    const cancelled = reduceTimeline(scheduled, {
      sequence: 5,
      event: { type: 'step.ended', sessionId: 'session-1', turn: 1, step: 2 },
    })
    expect(cancelled.nodes).toContainEqual({
      kind: 'retry',
      id: 'retry:retry-2',
      sequence: 4,
      turn: 1,
      step: 2,
      attempt: 1,
      state: 'cancelled',
      message: 'transport failed',
    })
  })

  it('merges compaction phases while keeping earlier accounting fields', () => {
    const start = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'compaction.updated',
        sessionId: 'session-1',
        compaction: { id: 'c1', phase: 'start' },
      },
    })
    const summary = reduceTimeline(start, {
      sequence: 2,
      event: {
        type: 'compaction.updated',
        sessionId: 'session-1',
        compaction: { id: 'c1', phase: 'summary', summary: 'Kept the task list.' },
      },
    })
    const end = reduceTimeline(summary, {
      sequence: 3,
      event: {
        type: 'compaction.updated',
        sessionId: 'session-1',
        compaction: { id: 'c1', phase: 'end', replacedCount: 12, estimatedTokens: 8_400 },
      },
    })
    expect(end.nodes).toEqual([
      {
        kind: 'compaction',
        id: 'compaction:c1',
        compaction: {
          id: 'c1',
          phase: 'end',
          summary: 'Kept the task list.',
          replacedCount: 12,
          estimatedTokens: 8_400,
        },
      },
    ])
  })
})
