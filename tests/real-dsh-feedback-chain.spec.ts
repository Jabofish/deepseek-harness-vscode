import { describe, expect, it } from 'vitest'

import type { DshTransport } from '../packages/dsh-adapter/src/contracts.js'
import { rc6Mapper } from '../packages/dsh-adapter/src/versions/rc6/mapper.js'
import { rc7Mapper } from '../packages/dsh-adapter/src/versions/rc7/mapper.js'
import { rc8Mapper } from '../packages/dsh-adapter/src/versions/rc8/mapper.js'
import { Rc6MessageFeedbackRepository } from '../packages/dsh-adapter/src/repositories/feedback-repository.js'
import { reduceTimeline } from '../packages/timeline/src/reducer.js'

const sessionId = 'message-feedback-protocol'
const durableMessageId = '11111111-1111-4111-8111-111111111111'

/**
 * These are the real shapes from deepseek-harness' checked-in fixtures:
 * `apps/web/tests/snapshots/message-feedback-protocol/session.jsonl` and
 * `packages/client/connection/src/client/fixture.ts` (`startReply`).
 */
const upstreamChunk = {
  type: 'assistant/chunk',
  sessionId,
  data: {
    turn: 1,
    step: 1,
    chunk: { type: 'text-delta', index: 0, text: 'A useful ' },
  },
} as const

const upstreamMessage = {
  type: 'assistant/message',
  sessionId,
  seq: 3,
  time: 1_786_406_400_004,
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'A useful answer.' }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      id: durableMessageId,
    },
    usage: { inputTokens: 4, outputTokens: 4 },
  },
  surfaceOp: 'append',
} as const

function feedbackTransport(
  calls: Array<{ endpoint: string; args: Readonly<Record<string, unknown>> }>,
): DshTransport {
  return {
    request: <T>() => Promise.resolve(undefined as T),
    remoteRequest: <T>(endpoint: string, args: Readonly<Record<string, unknown>>) => {
      calls.push({ endpoint, args })
      return Promise.resolve({
        ok: true,
        value: {
          ok: true,
          value: {
            messageId: durableMessageId,
            rating: 'positive',
            note: 'Useful answer',
            version: 'fixture-v1',
            createdAt: 1_786_406_400_010,
            updatedAt: 1_786_406_400_010,
          },
        },
      } as T)
    },
    openEventStream: async function* () {
      /* The chain under test starts at the checked-in event fixture. */
    },
    close: () => Promise.resolve(undefined),
  }
}

describe('real DSH feedback data chain', () => {
  it('maps upstream stream/final events into the real message id used by the feedback RPC', async () => {
    const initial = { sessionId, nodes: [], lastSequence: -1 } as const
    for (const mapper of [rc6Mapper, rc7Mapper, rc8Mapper])
      expect(mapper.event(upstreamMessage.type, upstreamMessage)).toMatchObject({
        type: 'message.completed',
        messageId: durableMessageId,
      })
    const streamed = reduceTimeline(initial, {
      sequence: 2,
      event: rc6Mapper.event(upstreamChunk.type, upstreamChunk),
    })
    const projected = reduceTimeline(streamed, {
      sequence: upstreamMessage.seq,
      event: rc6Mapper.event(upstreamMessage.type, upstreamMessage),
    })
    const assistant = projected.nodes.filter((node) => node.kind === 'assistant-message')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]).toMatchObject({
      id: durableMessageId,
      markdown: 'A useful answer.',
      streaming: false,
      turn: 1,
      step: 1,
    })

    const calls: Array<{ endpoint: string; args: Readonly<Record<string, unknown>> }> = []
    const repository = new Rc6MessageFeedbackRepository(feedbackTransport(calls))
    await expect(
      repository.put(sessionId, durableMessageId, 'positive', 'Useful answer'),
    ).resolves.toMatchObject({
      messageId: durableMessageId,
      rating: 'positive',
    })
    expect(calls).toEqual([
      {
        endpoint: 'messageFeedback/put',
        args: {
          request: {
            sessionId,
            messageId: durableMessageId,
            rating: 'positive',
            note: 'Useful answer',
            ifVersion: null,
          },
        },
      },
    ])
  })
})
