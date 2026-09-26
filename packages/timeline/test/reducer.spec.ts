import { describe, expect, it } from 'vitest'
import type { BackendEvent } from '@dsh-vscode/domain'
import { reduceTimeline, reduceTimelineBatch } from '../src/reducer.js'
import type { TimelineState } from '../src/nodes.js'

const initial: TimelineState = { sessionId: 'session-1', nodes: [], lastSequence: -1 }

describe('reduceTimeline', () => {
  it('matches sequential reduction while replaying a history batch', () => {
    const inputs = [
      {
        sequence: 1,
        event: { type: 'message.user', sessionId: 'session-1', messageId: 'u1', markdown: 'hello' } as const,
      },
      {
        sequence: 2,
        event: { type: 'message.delta', sessionId: 'session-1', messageId: 'a1', delta: 'answer' } as const,
      },
      {
        sequence: 3,
        event: {
          type: 'message.completed',
          sessionId: 'session-1',
          messageId: 'a1',
          markdown: 'answer',
        } as const,
      },
    ]
    const sequential = inputs.reduce((current, input) => reduceTimeline(current, input), initial)
    const batched = reduceTimelineBatch(initial, inputs)

    expect({ ...batched, nodeChangeBase: undefined }).toEqual({ ...sequential, nodeChangeBase: undefined })
  })

  it('reuses the timeline node array for session-only state events', () => {
    const state: TimelineState = {
      ...initial,
      nodes: [{ kind: 'user-message', id: 'user-1', markdown: 'hello' }],
      lastSequence: 4,
    }

    const status = reduceTimeline(state, {
      sequence: 5,
      event: { type: 'session.status', sessionId: 'session-1', status: 'running' },
    })
    const jobs = reduceTimeline(status, {
      sequence: 6,
      event: { type: 'jobs.updated', sessionId: 'session-1', jobs: [] },
    })

    expect(status.nodes).toBe(state.nodes)
    expect(jobs.nodes).toBe(state.nodes)
    expect(jobs.lastSequence).toBe(6)
  })

  it('reuses auxiliary reducer state when a delta carries no timing update', () => {
    const commandModes = { 'command-1': 'plan' as const }
    const stepTimings = {
      '1:0': { stepStartTime: 1_000, firstTokenTime: 1_200, completedTime: null },
    }
    const closedTurns = [9]
    const state: TimelineState = {
      ...initial,
      commandModes,
      stepTimings,
      closedTurns,
    }

    const next = reduceTimeline(state, {
      sequence: 1,
      event: { type: 'message.delta', sessionId: 'session-1', messageId: 'm1', delta: 'a' },
    })

    expect(next.commandModes).toBe(commandModes)
    expect(next.stepTimings).toBe(stepTimings)
    expect(next.closedTurns).toBe(closedTurns)
  })

  it('reuses nodes for empty open-turn deltas but invalidates a closed tail', () => {
    const openState: TimelineState = {
      ...initial,
      nodes: [{ kind: 'assistant-message', id: 'm1', markdown: 'answer', streaming: false }],
    }
    const openNext = reduceTimeline(openState, {
      sequence: 1,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'm1',
        turn: 1,
        delta: '',
      },
    })
    expect(openNext.nodes).toBe(openState.nodes)

    const closedState: TimelineState = {
      ...openState,
      nodes: [
        {
          kind: 'assistant-message',
          id: 'm1',
          markdown: 'answer',
          streaming: false,
          turn: 1,
          turnCompleted: true,
        },
      ],
      closedTurns: [1],
    }
    const closedNext = reduceTimeline(closedState, {
      sequence: 1,
      event: {
        type: 'reasoning.delta',
        sessionId: 'session-1',
        messageId: 'm1',
        turn: 1,
        delta: '',
      },
    })
    expect(closedNext.nodes).not.toBe(closedState.nodes)
    expect(closedNext.nodes[0]).toMatchObject({ turnCompleted: false })
  })

  it('publishes the delta change boundary with its source array identity', () => {
    const user = reduceTimeline(initial, {
      sequence: 1,
      event: { type: 'message.user', sessionId: 'session-1', messageId: 'u1', markdown: 'run' },
    })
    const first = reduceTimeline(user, {
      sequence: 2,
      event: { type: 'message.delta', sessionId: 'session-1', messageId: 'a1', delta: 'A' },
    })
    const second = reduceTimeline(first, {
      sequence: 3,
      event: { type: 'message.delta', sessionId: 'session-1', messageId: 'a1', delta: 'B' },
    })

    expect(first.nodeChangeStart).toBe(1)
    expect(first.nodeChangeBase).toBe(user.nodes)
    expect(second.nodeChangeStart).toBe(1)
    expect(second.nodeChangeBase).toBe(first.nodes)
  })

  it('maintains raw event counts incrementally across unknown events', () => {
    const first = reduceTimeline(
      { ...initial, eventCount: 0 },
      {
        sequence: 1,
        event: { type: 'unknown', name: 'future.event', payload: { value: 1 } },
      },
    )
    expect(first.eventCount).toBe(1)

    const second = reduceTimeline(first, {
      sequence: 2,
      event: { type: 'session.status', sessionId: 'session-1', status: 'running' },
    })
    expect(second.eventCount).toBe(1)
    expect(second.nodes).toBe(first.nodes)
  })

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

  it('replaces a same-attempt partial stream when a reconnect baseline restarts local sequence', () => {
    const partial = reduceTimeline(initial, {
      sequence: 1,
      advanceSequence: false,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'm1',
        delta: 'old prefix',
        turn: 1,
        step: 0,
        transientAttemptId: 'attempt-1',
        transientIndex: 0,
        transientSequence: 1,
      },
    })
    const advanced = reduceTimeline(partial, {
      sequence: 2,
      advanceSequence: false,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'm1',
        delta: ' old suffix',
        turn: 1,
        step: 0,
        transientAttemptId: 'attempt-1',
        transientIndex: 1,
        transientSequence: 2,
      },
    })
    const baseline = reduceTimeline(advanced, {
      sequence: 3,
      advanceSequence: false,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'm1',
        delta: 'fresh prefix',
        turn: 1,
        step: 0,
        transientAttemptId: 'attempt-1',
        transientIndex: 0,
        transientSequence: 1,
      },
    })

    expect(baseline.nodes).toEqual([
      expect.objectContaining({
        kind: 'assistant-message',
        markdown: 'fresh prefix',
        streaming: true,
        liveAttemptId: 'attempt-1',
        liveLastIndex: 0,
      }),
    ])
  })

  it('replaces a one-chunk attempt when its reconnect baseline follows hidden chunks', () => {
    const partial = reduceTimeline(initial, {
      sequence: 1,
      advanceSequence: false,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'm1',
        delta: 'old prefix',
        turn: 1,
        step: 0,
        transientAttemptId: 'attempt-1',
        transientIndex: 0,
        transientSequence: 1,
      },
    })
    const baseline = reduceTimeline(partial, {
      sequence: 2,
      advanceSequence: false,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'm1',
        delta: 'fresh prefix',
        turn: 1,
        step: 0,
        transientAttemptId: 'attempt-1',
        transientIndex: 2,
        transientSequence: 1,
      },
    })

    expect(baseline.nodes).toEqual([
      expect.objectContaining({
        kind: 'assistant-message',
        markdown: 'fresh prefix',
        liveAttemptId: 'attempt-1',
        liveLastIndex: 2,
      }),
    ])
  })

  it('replaces a baseline whose first visible chunk follows hidden stream chunks', () => {
    const partial = reduceTimeline(initial, {
      sequence: 1,
      advanceSequence: false,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'm1',
        delta: 'old prefix',
        turn: 1,
        step: 0,
        transientAttemptId: 'attempt-1',
        transientIndex: 2,
        transientSequence: 1,
      },
    })
    const advanced = reduceTimeline(partial, {
      sequence: 2,
      advanceSequence: false,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'm1',
        delta: ' old suffix',
        turn: 1,
        step: 0,
        transientAttemptId: 'attempt-1',
        transientIndex: 3,
        transientSequence: 2,
      },
    })
    const baseline = reduceTimeline(advanced, {
      sequence: 3,
      advanceSequence: false,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'm1',
        delta: 'fresh prefix',
        turn: 1,
        step: 0,
        transientAttemptId: 'attempt-1',
        transientIndex: 2,
        transientSequence: 1,
      },
    })

    expect(baseline.nodes).toEqual([
      expect.objectContaining({
        kind: 'assistant-message',
        markdown: 'fresh prefix',
        liveAttemptId: 'attempt-1',
        liveLastIndex: 2,
      }),
    ])
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
    expect(streamed.stepTimings).not.toBe(started.stepTimings)
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

  it('records the first reasoning token as the step TTFT like the official ledger', () => {
    const started = reduceTimeline(initial, {
      sequence: 1,
      event: { type: 'step.started', sessionId: 'session-1', turn: 1, step: 1, time: 1_000 },
    })
    const reasoned = reduceTimeline(started, {
      sequence: 2,
      event: {
        type: 'reasoning.delta',
        sessionId: 'session-1',
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        time: 1_200,
        delta: 'weighing options',
      },
    })
    const answered = reduceTimeline(reasoned, {
      sequence: 3,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        time: 5_000,
        delta: 'Hello',
      },
    })
    const completed = reduceTimeline(answered, {
      sequence: 4,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        time: 6_000,
        markdown: 'Hello',
      },
    })

    expect(completed.nodes).toContainEqual(
      expect.objectContaining({
        id: 'assistant:1:1',
        markdown: 'Hello',
        timing: { stepStartTime: 1_000, firstTokenTime: 1_200, completedTime: 6_000 },
      }),
    )
  })

  it('keeps a reasoning-only step as a TTFT sample', () => {
    let state = reduceTimeline(initial, {
      sequence: 1,
      event: { type: 'step.started', sessionId: 'session-1', turn: 1, step: 1, time: 1_000 },
    })
    state = reduceTimeline(state, {
      sequence: 2,
      event: {
        type: 'reasoning.delta',
        sessionId: 'session-1',
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        time: 1_200,
        delta: 'weighing options',
      },
    })
    state = reduceTimeline(state, {
      sequence: 3,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        time: 6_000,
        reasoning: 'weighing options',
      },
    })

    expect(state.nodes).toContainEqual(
      expect.objectContaining({
        id: 'assistant:1:1',
        timing: { stepStartTime: 1_000, firstTokenTime: 1_200, completedTime: 6_000 },
      }),
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

  it('keeps distinct durable assistant records at one turn and step', () => {
    const first = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'assistant-message-first',
        turn: 1,
        step: 1,
        markdown: 'first attempt result',
      },
    })
    const second = reduceTimeline(first, {
      sequence: 2,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'assistant-message-second',
        turn: 1,
        step: 1,
        markdown: 'second attempt result',
      },
    })

    expect(second.nodes).toEqual([
      expect.objectContaining({
        kind: 'assistant-message',
        id: 'assistant-message-first',
        markdown: 'first attempt result',
      }),
      expect.objectContaining({
        kind: 'assistant-message',
        id: 'assistant-message-second',
        markdown: 'second attempt result',
      }),
    ])
  })

  it('does not let a settled transient identity capture a later assistant record', () => {
    const streamed = reduceTimeline(initial, {
      sequence: 1,
      advanceSequence: false,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        delta: 'live prefix',
        transientAttemptId: 'attempt-1',
        transientIndex: 0,
        transientSequence: 1,
      },
    })
    const settled = reduceTimeline(streamed, {
      sequence: 2,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'assistant-message-first',
        turn: 1,
        step: 1,
        markdown: 'first result',
      },
    })
    const later = reduceTimeline(settled, {
      sequence: 3,
      event: {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'assistant-message-second',
        turn: 1,
        step: 1,
        markdown: 'later result',
      },
    })

    expect(later.nodes).toEqual([
      expect.objectContaining({
        kind: 'assistant-message',
        id: 'assistant-message-first',
        markdown: 'first result',
        streaming: false,
      }),
      expect.objectContaining({
        kind: 'assistant-message',
        id: 'assistant-message-second',
        markdown: 'later result',
        streaming: false,
      }),
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

  it('does not remove a newer retry when an earlier attempt settlement arrives late', () => {
    let state = reduceTimeline(initial, {
      sequence: 4,
      event: {
        type: 'message.delta',
        sessionId: 'session-1',
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        delta: 'new attempt',
        transientAttemptId: 'attempt-new',
        transientIndex: 0,
        transientSequence: 1,
        transientStartedAfterSequence: 5,
      },
    })
    state = reduceTimeline(state, {
      sequence: 5,
      event: { type: 'assistant.attempt', sessionId: 'session-1', turn: 1, step: 1 },
    })

    expect(state.nodes).toEqual([
      expect.objectContaining({
        kind: 'assistant-message',
        markdown: 'new attempt',
        liveAttemptId: 'attempt-new',
        liveStartedAfterSequence: 5,
        streaming: true,
      }),
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

  it('retains structured session-reference labels on hidden context nodes', () => {
    const next = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'message.user',
        sessionId: 'session-1',
        messageId: 'context-session-reference-1',
        markdown: 'recalled context',
        source: 'session-reference',
        sourceForm: 'recall',
        sessionReferenceLabels: ['Earlier debugging'],
      },
    })

    expect(next.nodes).toEqual([
      {
        kind: 'user-message',
        id: 'context-session-reference-1',
        markdown: 'recalled context',
        source: 'session-reference',
        sourceForm: 'recall',
        sessionReferenceLabels: ['Earlier debugging'],
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

  it('reconciles an image-bearing preview with the durable image projection', () => {
    const pending: TimelineState = {
      ...initial,
      nodes: [
        {
          kind: 'user-message',
          id: 'optimistic:user:webview-4',
          markdown: '看这张图',
          attachments: [{ name: 'screen.png', mimeType: 'image/png' }],
        },
      ],
    }
    const actual = reduceTimeline(pending, {
      sequence: 1,
      event: {
        type: 'message.user',
        sessionId: 'session-1',
        messageId: 'message-4',
        markdown: '看这张图',
        images: [{ attachmentId: 'image-1', mediaType: 'image/png', bytes: 4, width: 2, height: 2 }],
      },
    })

    expect(actual.nodes).toHaveLength(1)
    expect(actual.nodes[0]).toMatchObject({ kind: 'user-message', id: 'message-4' })
  })

  it('reconciles a file preview whose draft carried a media type', () => {
    const pending: TimelineState = {
      ...initial,
      nodes: [
        {
          kind: 'user-message',
          id: 'optimistic:user:webview-5',
          markdown: '概括文件内容',
          attachments: [{ name: 'notes.md', mimeType: 'text/markdown' }],
        },
      ],
    }
    const actual = reduceTimeline(pending, {
      sequence: 1,
      event: {
        type: 'message.user',
        sessionId: 'session-1',
        messageId: 'message-5',
        markdown: '概括文件内容',
        attachments: [{ name: 'notes.md' }],
      },
    })

    expect(actual.nodes).toHaveLength(1)
    expect(actual.nodes[0]).toMatchObject({ kind: 'user-message', id: 'message-5' })
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

  it('does not infer workflow termination from an unrelated step end', () => {
    const started = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'workflow.started',
        sessionId: 'session-1',
        workflow: {
          id: 'run-1',
          sessionId: 'session-1',
          name: 'ralph-loop',
          status: 'running',
          stages: [],
        },
      },
    })
    const withMembers = [
      { seq: 1, label: 'first', childId: 'child-1' },
      { seq: 2, label: 'second', childId: 'child-2' },
    ].reduce(
      (state, member, index) =>
        reduceTimeline(state, {
          sequence: index + 2,
          event: {
            type: 'workflow.member.started',
            sessionId: 'session-1',
            runId: 'run-1',
            phase: 'Fresh-agent rounds',
            member: { ...member, status: 'running' },
          },
        }),
      started,
    )
    const settled = reduceTimeline(withMembers, {
      sequence: 4,
      event: {
        type: 'workflow.member.ended',
        sessionId: 'session-1',
        runId: 'run-1',
        seq: 1,
        outcome: 'completed',
      },
    })
    // Without workflow turn ownership, only workflow events can settle it.
    const interrupted = reduceTimeline(settled, {
      sequence: 5,
      event: { type: 'step.ended', sessionId: 'session-1', turn: 1, step: 1 },
    })
    expect(interrupted.nodes).toMatchObject([
      {
        kind: 'workflow',
        workflow: {
          status: 'running',
          stages: [
            {
              phase: 'Fresh-agent rounds',
              members: [
                { seq: 1, status: 'completed' },
                { seq: 2, status: 'running' },
              ],
            },
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

  it('keeps a receipt when a queued record arrives after it', () => {
    const delivered = reduceTimeline(initial, {
      sequence: 1,
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
    const queued = reduceTimeline(delivered, {
      sequence: 2,
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
          content: 'Check the spacing rule before you claim the task.',
        },
      },
    })
    expect(queued.nodes).toHaveLength(1)
    expect(queued.nodes[0]).toMatchObject({
      kind: 'team',
      activity: { kind: 'message.delivered', content: 'Check the spacing rule before you claim the task.' },
    })
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
    expect(permission.nodes).toBe(initial.nodes)
    expect(question.nodes).toBe(initial.nodes)
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

  it('replaces the error notice with the turn row that carries the same failure', () => {
    const failure = {
      code: 'CONTEXT_WINDOW_EXCEEDED',
      message: 'Engine protocol predict request returned 400: exceed_context_size_error',
    }
    const noticed = reduceTimeline(initial, {
      sequence: 1,
      event: { type: 'notice', sessionId: 'session-1', level: 'error', text: failure.message },
    })
    const closed = reduceTimeline(noticed, {
      sequence: 2,
      event: { type: 'turn.ended', sessionId: 'session-1', turn: 4, reason: 'error', failure },
    })

    expect(noticed.nodes).toMatchObject([{ kind: 'notice', level: 'error' }])
    expect(closed.nodes.map((node) => node.kind)).toEqual(['turn-terminal'])
  })

  it('refuses a late error notice that repeats the turn failure already on screen', () => {
    const failure = {
      code: 'CONTEXT_WINDOW_EXCEEDED',
      message: 'Engine protocol predict request returned 400',
    }
    const closed = reduceTimeline(initial, {
      sequence: 1,
      event: { type: 'turn.ended', sessionId: 'session-1', turn: 4, reason: 'error', failure },
    })
    const withNotice = reduceTimeline(closed, {
      sequence: 2,
      event: {
        type: 'notice',
        sessionId: 'session-1',
        level: 'error',
        // The notice keeps the upstream text as sent while the failure text is
        // whitespace-compacted, so the two only match once collapsed.
        text: 'Engine  protocol\npredict request returned 400',
      },
    })

    expect(withNotice.nodes.map((node) => node.kind)).toEqual(['turn-terminal'])
  })

  it('keeps an error notice that is not the closing turn failure', () => {
    const closed = reduceTimeline(initial, {
      sequence: 1,
      event: {
        type: 'turn.ended',
        sessionId: 'session-1',
        turn: 4,
        reason: 'error',
        failure: { message: 'The provider is unavailable.' },
      },
    })
    const withNotice = reduceTimeline(closed, {
      sequence: 2,
      event: {
        type: 'notice',
        sessionId: 'session-1',
        level: 'error',
        text: 'The DSH command could not be applied. Details: invalid permission.',
      },
    })

    expect(withNotice.nodes.map((node) => node.kind)).toEqual(['turn-terminal', 'notice'])
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
