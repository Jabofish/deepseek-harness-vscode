import { describe, expect, it, vi } from 'vitest'
import { AppError, type UserQuestion } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import { Rc6InteractionRepository } from '../src/repositories/interaction-repository.js'

function singleQuestion(): UserQuestion {
  return {
    id: 'q-plan',
    rpcId: 'rpc-plan',
    sessionId: 's1',
    prompt: 'Proceed with this plan?',
    header: 'Refactor',
    choices: [
      { id: 'Approve', label: 'Approve', description: 'Run the plan now' },
      { id: 'Decline', label: 'Decline', description: 'Stop here' },
    ],
    allowFreeText: true,
    intent: { kind: 'plan-review', approve: 'Approve' },
  }
}

function recordingTransport(): {
  transport: DshTransport
  calls: { rpcId: string; payload: unknown; signal?: AbortSignal }[]
  release: (receipt?: unknown) => void
  fail: (error: Error) => void
} {
  const calls: { rpcId: string; payload: unknown; signal?: AbortSignal }[] = []
  let release: ((receipt?: unknown) => void) | undefined
  let fail: ((error: Error) => void) | undefined
  const transport: DshTransport = {
    request: <TResponse>() => Promise.resolve({ result: { ok: true, value: [] } } as TResponse),
    remoteRequest: <TResponse>() => Promise.resolve({ result: { ok: true, value: [] } } as TResponse),
    openEventStream: async function* () {
      /* fixture stream */
    },
    close: () => Promise.resolve(),
    // The real alpha transport passes the caller's signal into the
    // `$events/result` post, and the shared request path rejects with
    // REQUEST_CANCELLED when it aborts mid-flight.
    respondEnvelope: (rpcId: string, payload: unknown, signal?: AbortSignal) =>
      new Promise((resolve, reject) => {
        calls.push({ rpcId, payload, ...(signal === undefined ? {} : { signal }) })
        const aborted = (): void => {
          signal?.removeEventListener('abort', aborted)
          reject(
            new AppError({
              code: 'REQUEST_CANCELLED',
              message: 'The DSH request was cancelled.',
              retryable: false,
            }),
          )
        }
        signal?.addEventListener('abort', aborted, { once: true })
        if (signal?.aborted) aborted()
        release = (receipt = { accepted: true }) => {
          signal?.removeEventListener('abort', aborted)
          resolve(receipt)
        }
        fail = (error) => {
          signal?.removeEventListener('abort', aborted)
          reject(error)
        }
      }),
  }
  return { transport, calls, release: (receipt) => release?.(receipt), fail: (error) => fail?.(error) }
}

function rememberQuestion(repository: Rc6InteractionRepository): void {
  repository.remember({ type: 'question.requested', question: singleQuestion() })
}

describe('Rc6InteractionRepository shared-response isolation', () => {
  it('CONTROL: concurrent answers to one pending question collapse into a single wire response', async () => {
    const { transport, calls, release } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository)

    const first = repository.respondToQuestion('q-plan', 'Approve', new AbortController().signal)
    const second = repository.respondToQuestion('q-plan', 'Approve', new AbortController().signal)
    expect(calls).toHaveLength(1)

    release()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('cancelling one identical answer must not fail another live caller or resend the mutation', async () => {
    // Reachable trigger: the Webview question card and the task center answer
    // the same pending ask as two Host requests with their own signals. When
    // one of them is cancelled — e.g. the protocol client's 30 s budget fires
    // and it sends feature.request.cancel for that request id — the still-live
    // answer must still reach the host. The same repository family does this
    // correctly for queue enqueues: SessionPromptQueue.awaitQueueIdentity
    // shares the attempt but gates every caller with its own signal.
    const { transport, calls, release } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository)

    const cancelledCaller = new AbortController()
    const survivingCaller = new AbortController()

    const cancelled = repository.respondToQuestion('q-plan', 'Approve', cancelledCaller.signal)
    const surviving = repository.respondToQuestion('q-plan', 'Approve', survivingCaller.signal)
    expect(calls).toHaveLength(1)

    cancelledCaller.abort()

    await expect(cancelled).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(survivingCaller.signal.aborted).toBe(false)

    release()
    await expect(surviving).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('cancels a later identical caller independently and removes its listener', async () => {
    const { transport, calls, release } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository)
    const firstSignal = new AbortController()
    const laterSignal = new AbortController()
    const removeListener = vi.spyOn(laterSignal.signal, 'removeEventListener')
    const first = repository.respondToQuestion('q-plan', 'Approve', firstSignal.signal)
    const later = repository.respondToQuestion('q-plan', 'Approve', laterSignal.signal)
    const rejected = expect(later).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    laterSignal.abort()
    // Complete the wire only after the later caller has observed cancellation.
    // A shared Promise tied to the first caller would remain pending here.
    await rejected
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(calls[0]?.signal?.aborted).toBe(false)
    release()
    await expect(first).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('rejects a conflicting answer and a close while the first answer is in flight', async () => {
    const { transport, calls, release } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository)
    const first = repository.respondToQuestion('q-plan', 'Decline')
    const different = expect(repository.respondToQuestion('q-plan', 'Approve')).rejects.toMatchObject({
      code: 'BACKEND_BUSY',
      retryable: false,
    })
    const close = expect(repository.cancelQuestion('q-plan')).rejects.toMatchObject({
      code: 'BACKEND_BUSY',
      retryable: false,
    })
    // Release before awaiting: old code falsely reports both conflicts successful.
    release()
    await first
    await Promise.all([different, close])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload).toMatchObject({ value: { answer: { answers: [{ selected: ['Decline'] }] } } })
  })

  it('shares identical closes with independent cancellation and rejects an answer during close', async () => {
    const { transport, calls, release } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository)
    const controller = new AbortController()
    const first = repository.cancelQuestion('q-plan', controller.signal)
    const second = repository.cancelQuestion('q-plan')
    const conflict = expect(repository.respondToQuestion('q-plan', 'Approve')).rejects.toMatchObject({
      code: 'BACKEND_BUSY',
    })
    const cancelled = expect(first).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    controller.abort()
    await cancelled
    release()
    await second
    await conflict
    expect(calls).toHaveLength(1)
  })

  it('shares the same permission choice but never acknowledges a different choice or invalid option', async () => {
    const { transport, calls, release } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    repository.remember({
      type: 'permission.requested',
      request: {
        id: 'approval',
        rpcId: 'rpc-approval',
        sessionId: 's1',
        title: 'Fixture permission',
        description: 'Fixture operation',
        risk: 'unknown',
        options: [
          { id: 'allow', label: 'Allow', kind: 'allow-once' },
          { id: 'deny', label: 'Deny', kind: 'deny' },
        ],
      },
    })
    const controller = new AbortController()
    const first = repository.respondToPermission('approval', 'allow', controller.signal)
    const second = repository.respondToPermission('approval', 'allow')
    const conflict = expect(repository.respondToPermission('approval', 'deny')).rejects.toMatchObject({
      code: 'BACKEND_BUSY',
    })
    const invalid = expect(repository.respondToPermission('approval', 'missing')).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    })
    const cancelled = expect(first).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    controller.abort()
    await cancelled
    release()
    await second
    await Promise.all([conflict, invalid])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload).toMatchObject({ value: { outcome: 'allowed-once' } })
  })

  it('aborts the wire only when every caller has left and does not automatically resend', async () => {
    const { transport, calls } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository)
    const a = new AbortController()
    const b = new AbortController()
    const first = repository.respondToQuestion('q-plan', 'Approve', a.signal)
    const second = repository.respondToQuestion('q-plan', 'Approve', b.signal)
    const cancelled = Promise.all([
      expect(first).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' }),
      expect(second).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' }),
    ])
    b.abort()
    expect(calls[0]?.signal?.aborted).toBe(false)
    a.abort()
    await cancelled
    expect(calls[0]?.signal?.aborted).toBe(true)
    expect(calls).toHaveLength(1)
    expect(repository.sessionForQuestion('q-plan')).toBe('s1')
  })

  it('rejects pre-cancelled callers without sending or joining an interaction mutation', async () => {
    const { transport, calls, release } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository)
    const controller = new AbortController()
    controller.abort()
    await expect(repository.respondToQuestion('q-plan', 'Approve', controller.signal)).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    })
    expect(calls).toHaveLength(0)
    const first = repository.respondToQuestion('q-plan', 'Approve')
    const rejected = expect(
      repository.respondToQuestion('q-plan', 'Approve', controller.signal),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    release()
    await Promise.all([first, rejected])
    expect(calls).toHaveLength(1)
  })

  it('keeps an abandoned response in flight until its unknown receipt settles, without sending a replacement', async () => {
    // dsh-v0.2.1-alpha.2 d74326738864, gateway/src/index.ts:
    // receiveRemoteEventResult settles before the HTTP acknowledgement returns.
    // Cancellation cannot establish that the server has not accepted a result.
    const { transport, calls, release } = recordingTransport()
    const wire = transport.respondEnvelope!.bind(transport)
    transport.respondEnvelope = (rpcId, payload) => wire(rpcId, payload)
    const settled = vi.fn()
    const repository = new Rc6InteractionRepository(transport, { onSettled: settled })
    rememberQuestion(repository)
    const controller = new AbortController()
    const first = repository.respondToQuestion('q-plan', 'Decline', controller.signal)
    const cancelled = expect(first).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    controller.abort()
    await cancelled
    await expect(repository.respondToQuestion('q-plan', 'Approve')).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    })
    expect(calls).toHaveLength(1)
    expect(settled).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'answered' }))
    expect(calls[0]?.payload).toMatchObject({ value: { answer: { answers: [{ selected: ['Decline'] }] } } })
    expect(calls).toHaveLength(1)
  })

  it.each(['business', 'malformed', 'timeout'] as const)(
    'releases callers after a %s failure, preserving the pending question for explicit recovery',
    async (kind) => {
      const { transport, calls, release, fail } = recordingTransport()
      const settled = vi.fn()
      const repository = new Rc6InteractionRepository(transport, { onSettled: settled })
      rememberQuestion(repository)
      const controller = new AbortController()
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
      const first = repository.respondToQuestion('q-plan', 'Approve', controller.signal)
      const second = repository.respondToQuestion('q-plan', 'Approve')
      const code =
        kind === 'business'
          ? 'STALE_INTERACTION'
          : kind === 'malformed'
            ? 'PROTOCOL_ERROR'
            : 'BACKEND_UNREACHABLE'
      const rejected = Promise.all([
        expect(first).rejects.toMatchObject({ code }),
        expect(second).rejects.toMatchObject({ code }),
      ])
      if (kind === 'timeout') fail(new AppError({ code, message: 'Fixture timeout', retryable: true }))
      else release(kind === 'business' ? { accepted: false, reason: 'not-pending' } : {})
      await rejected
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
      expect(settled).not.toHaveBeenCalled()
      expect(repository.sessionForQuestion('q-plan')).toBe('s1')
      expect(calls).toHaveLength(1)
      const retry = repository.respondToQuestion('q-plan', 'Decline')
      release()
      await retry
      expect(calls).toHaveLength(2)
      expect(settled).toHaveBeenCalledTimes(1)
    },
  )
})
