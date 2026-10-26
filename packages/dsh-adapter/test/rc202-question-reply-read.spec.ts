import { describe, expect, it } from 'vitest'
import { Rc202UserQuestionRepository } from '../src/versions/rc202/user-question-repository.js'
import type { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'

describe('post-answer native reply baseline', () => {
  it.each(['queued', 'claimed', 'released', 'admitted', 'settled', 'unknown'] as const)(
    'returns only %s metadata and closes its logical stream',
    async (state) => {
      let closed = false
      let readSignal: AbortSignal | undefined
      const repository = new Rc202UserQuestionRepository({
        openSessionStream: async function* (sessionId: string, signal: AbortSignal) {
          await Promise.resolve()
          readSignal = signal
          expect(sessionId).toBe('s1')
          try {
            yield { type: 'session/event', event: { private: 'private answer body' } }
            if (state !== 'unknown' && state !== 'settled')
              yield { type: 'question/reply-status', callId: 'call-q', state, asOfSequence: 101 }
            yield {
              type: 'session/subscribed',
              projections: {
                asOfSeq: 101,
                values: {
                  userQuestions: {
                    active: [],
                    settled: state === 'settled' ? [{ callId: 'call-q', answers: [] }] : [],
                  },
                },
              },
            }
            throw new Error('The read must stop at its baseline')
          } finally {
            closed = true
          }
        },
      } as unknown as AlphaLoopbackApiClient)
      const result = await repository.readReplyStatus('s1', 'call-q')
      expect(result).toEqual({ state, asOfSequence: 101 })
      expect(JSON.stringify(result)).not.toContain('private answer body')
      expect(closed).toBe(true)
      expect(readSignal?.aborted).toBe(true)
      await repository.close()
    },
  )

  it('rejects malformed or missing baselines and preserves a read failure', async () => {
    for (const frames of [
      [],
      [{ type: 'session/subscribed', projections: { asOfSeq: 'bad' } }],
      [
        {
          type: 'session/subscribed',
          projections: {
            asOfSeq: 101,
            values: { userQuestions: { active: [], settled: [{ callId: 'call-q', answers: 'bad' }] } },
          },
        },
      ],
      [{ type: 'question/reply-status', callId: 'call-q', state: 'released', asOfSequence: 1.5 }],
    ]) {
      const repository = new Rc202UserQuestionRepository({
        openSessionStream: async function* () {
          await Promise.resolve()
          yield* frames
        },
      } as unknown as AlphaLoopbackApiClient)
      await expect(repository.readReplyStatus('s1', 'call-q')).rejects.toMatchObject({
        code: 'PROTOCOL_ERROR',
      })
      await repository.close()
    }
    const failure = new Error('Native read failed')
    const repository = new Rc202UserQuestionRepository({
      openSessionStream: async function* () {
        yield await Promise.reject(failure)
      },
    } as unknown as AlphaLoopbackApiClient)
    await expect(repository.readReplyStatus('s1', 'call-q')).rejects.toBe(failure)
    await repository.close()
  })
})
