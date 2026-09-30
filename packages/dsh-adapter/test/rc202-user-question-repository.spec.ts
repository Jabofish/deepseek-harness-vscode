import { describe, expect, it } from 'vitest'
import { AppError } from '@dsh-vscode/domain'
import { Rc202UserQuestionRepository } from '../src/versions/rc202/user-question-repository.js'
import { normalizeRc202ErrorCode } from '../src/versions/rc202/error-vocabulary.js'
import type { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'

function repository(transport: Partial<AlphaLoopbackApiClient>): Rc202UserQuestionRepository {
  return new Rc202UserQuestionRepository(transport as AlphaLoopbackApiClient)
}

describe('DSH 0.2.0-rc.2 timed userQuestions Remote contract', () => {
  it('answers a continued call once with the complete structured batch', async () => {
    const calls: unknown[] = []
    const questions = repository({
      remoteRequest: <TResponse>(endpoint: string, args: Readonly<Record<string, unknown>>) => {
        calls.push({ endpoint, args })
        return Promise.resolve({ ok: true, value: true } as TResponse)
      },
    })

    await expect(
      questions.answer('session-1', 'call-1', {
        answers: [
          { id: 'scope', selected: ['workspace'], custom: 'include tests' },
          { id: 'deadline', selected: [] },
        ],
      }),
    ).resolves.toBe(true)
    expect(calls).toEqual([
      {
        endpoint: 'userQuestions/answer',
        args: {
          agentId: 'session-1',
          callId: 'call-1',
          answer: {
            answers: [
              { id: 'scope', selected: ['workspace'], custom: 'include tests' },
              { id: 'deadline', selected: [] },
            ],
          },
        },
      },
    ])
  })

  it('reports an already queued answer as stale instead of fabricating acceptance', async () => {
    const questions = repository({
      remoteRequest: () =>
        Promise.reject(
          new AppError({
            code: 'BACKEND_BUSY',
            message: 'The DSH session is currently owned by another DSH writer.',
            retryable: true,
            // Shape produced by the transport: rc202 normalizes the wire's
            // REPLY_QUEUED to `writer-held` and preserves the wire spelling.
            context: { rpcCode: 'writer-held', wireCode: 'REPLY_QUEUED', rpcMethod: 'userQuestions/answer' },
          }),
        ),
    })

    // Upstream throws REPLY_QUEUED both for this client's own recorded answer
    // and for someone else's reply already sitting in the Inbox. Because the
    // error cannot distinguish them, the batch must not be reported as
    // accepted; the Webview reads queued state from the Inbox projection.
    await expect(
      questions.answer('session-1', 'call-1', { answers: [{ id: 'scope', selected: ['workspace'] }] }),
    ).rejects.toMatchObject({ code: 'STALE_INTERACTION', retryable: false })
  })

  it('leaves a caller-liveness writer conflict as the writer conflict it is', async () => {
    const questions = repository({
      remoteRequest: () =>
        Promise.reject(
          new AppError({
            code: 'BACKEND_BUSY',
            message: 'The DSH session is currently owned by another DSH writer.',
            retryable: true,
            // CALLER_NOT_LIVE normalizes onto the same `writer-held`, but it
            // describes a different failure and must not be relabelled as a
            // duplicate reply.
            context: {
              rpcCode: 'writer-held',
              wireCode: 'CALLER_NOT_LIVE',
              rpcMethod: 'userQuestions/answer',
            },
          }),
        ),
    })

    await expect(
      questions.answer('session-1', 'call-1', { answers: [{ id: 'scope', selected: ['workspace'] }] }),
    ).rejects.toMatchObject({ code: 'BACKEND_BUSY' })
  })

  it('keeps the attachWait stream alive after its one remaining-time frame and releases it on close', async () => {
    let streamSignal: AbortSignal | undefined
    const questions = repository({
      openRemoteStream: (endpoint: string, args: Record<string, unknown>, signal?: AbortSignal) => {
        expect(endpoint).toBe('userQuestions/attachWait')
        expect(args).toEqual({ agentId: 'session-1', callId: 'call-1' })
        streamSignal = signal
        return (async function* () {
          yield { remainingMs: 4_250 }
          await new Promise<void>((resolve) =>
            signal?.addEventListener('abort', () => resolve(), { once: true }),
          )
        })()
      },
    })

    await expect(questions.attachWait('session-1', 'call-1')).resolves.toBe(4_250)
    expect(streamSignal?.aborted).toBe(false)
    await questions.releaseWait('session-1', 'call-1')
    expect(streamSignal?.aborted).toBe(true)
  })

  it('treats an ended stream as an already closed foreground wait', async () => {
    const questions = repository({
      openRemoteStream: async function* () {
        await Promise.resolve()
        yield* []
      },
    })
    await expect(questions.attachWait('session-1', 'call-1')).resolves.toBeUndefined()
  })

  it('rejects malformed wait frames and malformed duplicate answer ids', async () => {
    const malformed = repository({
      openRemoteStream: async function* () {
        await Promise.resolve()
        yield { remainingMs: 100, deadline: 123 }
      },
    })
    await expect(malformed.attachWait('session-1', 'call-1')).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    await expect(
      malformed.answer('session-1', 'call-1', {
        answers: [
          { id: 'q1', selected: [] },
          { id: 'q1', selected: ['duplicate'] },
        ],
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('maps only the rc.2 userQuestions business errors at the version boundary', () => {
    expect(normalizeRc202ErrorCode('REPLY_QUEUED', {})).toBe('writer-held')
    expect(normalizeRc202ErrorCode('BAD_ANSWER', {})).toBe('bad-request')
    expect(normalizeRc202ErrorCode('gateway/internal', {})).toBe('internal')
  })
})
