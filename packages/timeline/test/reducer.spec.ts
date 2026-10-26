import { describe, expect, it } from 'vitest'

import { reduceTimeline } from '../src/reducer.js'
import type { TimelineState } from '../src/nodes.js'

const initial: TimelineState = { sessionId: 'session-1', nodes: [], lastSequence: -1 }

describe('reduceTimeline', () => {
  it('places explicit delivered files by their durable event sequence and ignores catalog refresh rows', () => {
    const delivered = reduceTimeline(initial, {
      sequence: 4,
      event: {
        type: 'deliverables.presented',
        sessionId: 'session-1',
        turn: 1,
        callId: 'call-present',
        files: [{ path: 'artifacts/report.txt', description: 'Generated report' }],
      },
    })
    expect(delivered).toMatchObject({
      lastSequence: 4,
      nodes: [
        {
          kind: 'deliverables',
          id: 'deliverables:call-present',
          sequence: 4,
          turn: 1,
          files: [{ path: 'artifacts/report.txt', description: 'Generated report' }],
        },
      ],
    })

    const catalog = reduceTimeline(delivered, {
      sequence: 5,
      event: {
        type: 'subagent.catalog.updated',
        sessionId: 'session-1',
        entry: { id: 'child-1', createdAt: 10, mode: 'one-shot' },
      },
    })
    expect(catalog.lastSequence).toBe(5)
    expect(catalog.nodes).toBe(delivered.nodes)
  })

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

  it('deduplicates reconnect baseline frames without advancing the durable cursor', () => {
    const first = reduceTimeline(initial, {
      sequence: 1,
      advanceSequence: false,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'm1',
        delta: 'Hello',
        turn: 1,
        step: 0,
        transientAttemptId: 'attempt-1',
        transientIndex: 0,
        transientSequence: 1,
      },
    })
    const duplicate = reduceTimeline(first, {
      sequence: 2,
      advanceSequence: false,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'm1',
        delta: 'Hello',
        turn: 1,
        step: 0,
        transientAttemptId: 'attempt-1',
        transientIndex: 0,
        transientSequence: 2,
      },
    })
    const continued = reduceTimeline(duplicate, {
      sequence: 3,
      advanceSequence: false,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'm1',
        delta: ' world',
        turn: 1,
        step: 0,
        transientAttemptId: 'attempt-1',
        transientIndex: 1,
        transientSequence: 3,
      },
    })

    expect(duplicate.nodes).toEqual(first.nodes)
    expect(continued.nodes).toEqual([
      expect.objectContaining({
        kind: 'assistant-message',
        markdown: 'Hello world',
        liveAttemptId: 'attempt-1',
        liveLastIndex: 1,
      }),
    ])
    expect(continued.lastSequence).toBe(-1)
  })

  it('replaces stale transient answer and reasoning attempts without replaying old text', () => {
    const answer = reduceTimeline(initial, {
      sequence: 1,
      advanceSequence: false,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'm1',
        delta: 'old answer',
        turn: 1,
        step: 0,
        transientAttemptId: 'attempt-old',
        transientIndex: 0,
        transientSequence: 1,
      },
    })
    const replacedAnswer = reduceTimeline(answer, {
      sequence: 2,
      advanceSequence: false,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'm1',
        delta: 'new answer',
        turn: 1,
        step: 0,
        transientAttemptId: 'attempt-new',
        transientIndex: 0,
        transientSequence: 2,
      },
    })
    expect(replacedAnswer.nodes).toContainEqual(
      expect.objectContaining({ markdown: 'new answer', liveAttemptId: 'attempt-new', liveLastIndex: 0 }),
    )

    const reasoning = reduceTimeline(initial, {
      sequence: 3,
      advanceSequence: false,
      event: {
        type: 'reasoning.delta',
        sessionId: 'session-1',
        messageId: 'm1',
        delta: 'old reasoning',
        turn: 1,
        step: 0,
        transientAttemptId: 'attempt-old',
        transientIndex: 0,
        transientSequence: 3,
      },
    })
    const replacedReasoning = reduceTimeline(reasoning, {
      sequence: 4,
      advanceSequence: false,
      event: {
        type: 'reasoning.delta',
        sessionId: 'session-1',
        messageId: 'm1',
        delta: 'new reasoning',
        turn: 1,
        step: 0,
        transientAttemptId: 'attempt-new',
        transientIndex: 0,
        transientSequence: 4,
      },
    })
    const reasoningNode = replacedReasoning.nodes.find((node) => node.kind === 'assistant-message')
    expect(reasoningNode).toBeDefined()
    if (reasoningNode?.kind !== 'assistant-message') throw new Error('expected an assistant message node')
    expect(reasoningNode.reasoning?.markdown).toBe('new reasoning')
    expect(reasoningNode.liveAttemptId).toBe('attempt-new')
    expect(reasoningNode.liveLastIndex).toBe(0)

    const answerAfterReasoning = reduceTimeline(reasoning, {
      sequence: 5,
      advanceSequence: false,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'm1',
        delta: 'new answer',
        turn: 1,
        step: 0,
        transientAttemptId: 'attempt-new',
        transientIndex: 0,
        transientSequence: 5,
      },
    })
    const answerNode = answerAfterReasoning.nodes.find((node) => node.kind === 'assistant-message')
    expect(answerNode).toMatchObject({
      kind: 'assistant-message',
      markdown: 'new answer',
      liveAttemptId: 'attempt-new',
      liveLastIndex: 0,
    })
    expect(answerNode?.kind === 'assistant-message' ? answerNode.reasoning : undefined).toBeUndefined()
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

  it('removes a failed assistant attempt before rendering the retried answer', () => {
    let state = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        delta: 'failed prefix',
        transientAttemptId: 'attempt-failed',
        transientIndex: 0,
        transientSequence: 1,
      },
    })
    state = reduceTimeline(state, {
      sequence: 2,
      event: { type: 'assistant.attempt', sessionId: 'session-1', turn: 1, step: 1, time: 20 },
    })
    expect(state.nodes).toEqual([])
    expect(state.lastSequence).toBe(2)

    state = reduceTimeline(state, {
      sequence: 3,
      event: {
        type: 'model.retry',
        retry: {
          id: 'retry-1',
          sessionId: 'session-1',
          turn: 1,
          step: 1,
          attempt: 2,
          state: 'scheduled',
        },
      },
    })
    state = reduceTimeline(state, {
      sequence: 4,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        delta: 'final answer',
        transientAttemptId: 'attempt-final',
        transientIndex: 0,
        transientSequence: 2,
      },
    })
    state = reduceTimeline(state, {
      sequence: 5,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'assistant-message-final',
        turn: 1,
        step: 1,
        markdown: 'final answer',
      },
    })

    expect(state.nodes).toEqual([
      expect.objectContaining({
        kind: 'retry',
        id: 'retry:retry-1',
      }),
      expect.objectContaining({
        kind: 'assistant-message',
        id: 'assistant-message-final',
        markdown: 'final answer',
        streaming: false,
      }),
    ])
    expect(state.nodes).not.toContainEqual(expect.objectContaining({ markdown: 'failed prefix' }))
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

  it('retains producer-owned user messages as non-chat context nodes', () => {
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

    expect(next).toEqual(initial)
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
    const duplicate = reduceTimeline(two, {
      sequence: 2,
      advanceSequence: false,
      event: {
        type: 'tool.updated',
        sessionId: 'session-1',
        tool: { ...tool, status: 'completed', metadata: {} },
      },
    })
    expect(duplicate.nodes[0]).toBe(two.nodes[0])
    expect(duplicate.nodes).toBe(two.nodes)
    expect(duplicate.lastSequence).toBe(2)
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

  it('advances one peer message row from queued to delivered instead of appending a receipt card', () => {
    const queued = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'team.updated',
        sessionId: 'session-1',
        activity: {
          kind: 'message.queued',
          id: 'team:message:queued:team-1:team-message-1',
          teamId: 'team-1',
          messageId: 'team-message-1',
          senderName: 'Planner',
          targetId: 'member-1',
          delivery: 'wakeup',
          content: 'Check the spacing rule before you claim the task.',
        },
      },
    })
    const delivered = reduceTimeline(queued, {
      // The receipt carries no body: the host acknowledges the message it already
      // stored, so the row it advances keeps the text the queued record carried.
      sequence: 2,
      event: {
        type: 'team.updated',
        sessionId: 'session-1',
        activity: {
          kind: 'message.delivered',
          id: 'team:message:delivered:team-1:team-message-1',
          teamId: 'team-1',
          messageId: 'team-message-1',
          targetId: 'member-1',
        },
      },
    })
    expect(queued.nodes).toHaveLength(1)
    expect(delivered.nodes).toHaveLength(1)
    expect(delivered.nodes[0]).toMatchObject({
      kind: 'team',
      activity: {
        kind: 'message.delivered',
        messageId: 'team-message-1',
        senderName: 'Planner',
        targetId: 'member-1',
        delivery: 'wakeup',
        content: 'Check the spacing rule before you claim the task.',
      },
    })
  })

  it('keeps live permission and question requests out of the durable timeline', () => {
    const permission = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'permission.requested',
        request: {
          id: 'permission-1',
          sessionId: 'session-1',
          title: 'Allow the command?',
          description: 'The command needs approval.',
          risk: 'medium',
          options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }],
        },
      },
    })
    const question = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'question.requested',
        question: {
          id: 'question-1',
          sessionId: 'session-1',
          prompt: 'Choose a mode',
          choices: [{ id: 'chat', label: 'Chat' }],
          allowFreeText: false,
        },
      },
    })

    expect(permission.nodes).toEqual([])
    expect(question.nodes).toEqual([])
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
