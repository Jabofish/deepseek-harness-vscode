import { describe, expect, it } from 'vitest'
import type { BackendEvent, TokenUsage } from '@dsh-vscode/domain'
import { reduceTimelineBatch } from '../src/reducer.js'
import type { TimelineNode, TimelineState } from '../src/nodes.js'

const initial: TimelineState = { sessionId: 'session-1', nodes: [], lastSequence: -1 }

function replay(events: readonly BackendEvent[]): TimelineState {
  return reduceTimelineBatch(
    initial,
    events.map((event, index) => ({ sequence: index + 1, event })),
  )
}

function assistantNodes(state: TimelineState): Extract<TimelineNode, { kind: 'assistant-message' }>[] {
  return state.nodes.filter(
    (node): node is Extract<TimelineNode, { kind: 'assistant-message' }> => node.kind === 'assistant-message',
  )
}

function usage(
  inputTokens: number,
  outputTokens: number,
  optional: Pick<TokenUsage, 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens' | 'totalTokens'> = {},
): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      optional.totalTokens ??
      inputTokens + (optional.cacheReadTokens ?? 0) + (optional.cacheWriteTokens ?? 0) + outputTokens,
    ...optional,
  }
}

function turnStarted(): BackendEvent {
  return { type: 'turn.started', sessionId: 'session-1', turn: 1 }
}

function stepStarted(step: number): BackendEvent {
  return { type: 'step.started', sessionId: 'session-1', turn: 1, step }
}

function stepEnded(step: number): BackendEvent {
  return { type: 'step.ended', sessionId: 'session-1', turn: 1, step }
}

function messageCompleted(
  step: number,
  tokenUsage: TokenUsage | undefined,
  markdown = 'Answer',
): BackendEvent {
  return {
    type: 'message.completed',
    sessionId: 'session-1',
    messageId: `assistant-${step}`,
    turn: 1,
    step,
    ...(markdown === '' ? {} : { markdown }),
    ...(tokenUsage === undefined ? {} : { usage: tokenUsage }),
  }
}

function assistantAttempt(step: number, tokenUsage: TokenUsage | undefined): BackendEvent {
  return {
    type: 'assistant.attempt',
    sessionId: 'session-1',
    turn: 1,
    step,
    ...(tokenUsage === undefined ? {} : { usage: tokenUsage }),
  }
}

function retry(state: 'scheduled' | 'started', attempt = 1): BackendEvent {
  return {
    type: 'model.retry',
    retry: {
      sessionId: 'session-1',
      id: 'retry-1',
      turn: 1,
      step: 1,
      attempt,
      state,
    },
  }
}

function turnEnded(
  reason: Extract<BackendEvent, { type: 'turn.ended' }>['reason'] = 'completed',
): BackendEvent {
  return { type: 'turn.ended', sessionId: 'session-1', turn: 1, reason }
}

describe('completed Turn usage evidence', () => {
  it('publishes exact usage only after a complete lifecycle window', () => {
    const state = replay([
      turnStarted(),
      stepStarted(1),
      messageCompleted(1, usage(10, 5)),
      stepEnded(1),
      turnEnded(),
    ])

    expect(assistantNodes(state)).toContainEqual(
      expect.objectContaining({
        turn: 1,
        turnCompleted: true,
        turnUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
    )
  })

  it('sums tool-only steps and failed attempts retried at the same step', () => {
    const state = replay([
      turnStarted(),
      stepStarted(1),
      assistantAttempt(1, usage(4, 2, { cacheReadTokens: 1, cacheWriteTokens: 0 })),
      retry('scheduled'),
      retry('started'),
      messageCompleted(1, usage(6, 3, { cacheReadTokens: 2, cacheWriteTokens: 0 }), ''),
      stepEnded(1),
      {
        type: 'tool.updated',
        sessionId: 'session-1',
        tool: {
          id: 'tool-1',
          name: 'read',
          category: 'filesystem',
          title: 'Read',
          status: 'completed',
          metadata: {},
          turn: 1,
        },
      },
      stepStarted(2),
      messageCompleted(2, usage(6, 3, { cacheReadTokens: 2, cacheWriteTokens: 0 })),
      stepEnded(2),
      turnEnded(),
    ])

    expect(assistantNodes(state)).toContainEqual(
      expect.objectContaining({
        id: 'assistant-2',
        turnUsage: {
          inputTokens: 16,
          outputTokens: 8,
          totalTokens: 29,
          cacheReadTokens: 5,
          cacheWriteTokens: 0,
        },
      }),
    )
    expect(assistantNodes(state)).toHaveLength(1)
  })

  it('requires exact totals or both cache buckets for every attempt', () => {
    const withExactTotal = replay([
      turnStarted(),
      stepStarted(1),
      messageCompleted(1, { inputTokens: 10, outputTokens: 5, totalTokens: 19 }),
      stepEnded(1),
      turnEnded(),
    ])
    const withoutExactEvidence = replay([
      turnStarted(),
      stepStarted(1),
      messageCompleted(1, { inputTokens: 10, outputTokens: 5 }),
      stepEnded(1),
      turnEnded(),
    ])

    expect(assistantNodes(withExactTotal).at(-1)?.turnUsage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 19,
    })
    expect(assistantNodes(withoutExactEvidence).at(-1)?.turnUsage).toBeUndefined()
  })

  it('hides totals for a partial page or reconnect window that lacks turn/start', () => {
    const completeWindow = [
      turnStarted(),
      stepStarted(1),
      messageCompleted(1, usage(10, 5)),
      stepEnded(1),
      turnEnded(),
    ]
    const partialWindow = replay(completeWindow.slice(1))
    const reconnectedWindow = replay(completeWindow)

    expect(assistantNodes(partialWindow).at(-1)?.turnUsage).toBeUndefined()
    expect(assistantNodes(reconnectedWindow).at(-1)?.turnUsage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    })
  })

  it.each([
    {
      name: 'missing usage',
      events: [turnStarted(), stepStarted(1), messageCompleted(1, undefined), stepEnded(1), turnEnded()],
    },
    {
      name: 'a failed attempt without usage',
      events: [
        turnStarted(),
        stepStarted(1),
        assistantAttempt(1, undefined),
        retry('scheduled'),
        retry('started'),
        messageCompleted(1, usage(10, 5)),
        stepEnded(1),
        turnEnded(),
      ],
    },
    {
      name: 'an unstarted completed step',
      events: [turnStarted(), messageCompleted(1, usage(10, 5)), turnEnded()],
    },
    {
      name: 'a failed Turn',
      events: [
        turnStarted(),
        stepStarted(1),
        messageCompleted(1, usage(10, 5)),
        stepEnded(1),
        turnEnded('error'),
      ],
    },
    {
      name: 'a retry start without a matching scheduled retry',
      events: [
        turnStarted(),
        stepStarted(1),
        assistantAttempt(1, usage(5, 2)),
        retry('started'),
        messageCompleted(1, usage(10, 5)),
        stepEnded(1),
        turnEnded(),
      ],
    },
    {
      name: 'contradictory duplicate usage for one step',
      events: [
        turnStarted(),
        stepStarted(1),
        messageCompleted(1, usage(10, 5)),
        messageCompleted(1, usage(11, 5)),
        stepEnded(1),
        turnEnded(),
      ],
    },
  ])('does not expose partial usage when $name', ({ events }) => {
    const state = replay(events)
    expect(assistantNodes(state).at(-1)?.turnUsage).toBeUndefined()
  })

  it.each([
    {
      name: 'total less than its output',
      sample: { inputTokens: 10, outputTokens: 5, totalTokens: 4 },
    },
    {
      name: 'total conflicts with both cache buckets',
      sample: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 18 },
    },
    {
      name: 'reasoning exceeds output',
      sample: { inputTokens: 10, outputTokens: 5, reasoningTokens: 6, totalTokens: 15 },
    },
  ])('rejects a $name sample', ({ sample }) => {
    const state = replay([
      turnStarted(),
      stepStarted(1),
      messageCompleted(1, sample),
      stepEnded(1),
      turnEnded(),
    ])
    expect(assistantNodes(state).at(-1)?.turnUsage).toBeUndefined()
  })

  it('omits optional cache and reasoning aggregates unless all attempts report them', () => {
    const state = replay([
      turnStarted(),
      stepStarted(1),
      assistantAttempt(1, usage(4, 2)),
      retry('scheduled'),
      retry('started'),
      messageCompleted(1, usage(6, 3, { cacheReadTokens: 1, reasoningTokens: 2 })),
      stepEnded(1),
      turnEnded(),
    ])

    expect(assistantNodes(state).at(-1)?.turnUsage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 16,
    })
  })

  it('removes completed usage when a late step invalidates the Turn tail', () => {
    const completed = replay([
      turnStarted(),
      stepStarted(1),
      messageCompleted(1, usage(10, 5)),
      stepEnded(1),
      turnEnded(),
    ])
    const invalidated = reduceTimelineBatch(completed, [{ sequence: 6, event: stepStarted(2) }])

    expect(assistantNodes(invalidated).at(-1)).toMatchObject({ turnCompleted: false, turnUsage: undefined })
  })
})
