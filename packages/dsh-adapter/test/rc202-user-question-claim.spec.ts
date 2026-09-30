import { describe, expect, it } from 'vitest'
import { AppError } from '@dsh-vscode/domain'
import { Rc202UserQuestionRepository } from '../src/versions/rc202/user-question-repository.js'
import type { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'

function repository(transport: Partial<AlphaLoopbackApiClient>): Rc202UserQuestionRepository {
  return new Rc202UserQuestionRepository(transport as AlphaLoopbackApiClient)
}

/**
 * Stand-in for `AlphaRemoteMux.open`, whose abort handling ends the receive
 * queue so a pending `iterator.next()` settles. The real transport wires
 * `handleAbort` exactly this way; a fake that never settles would prove
 * nothing about the repository.
 */
function abortAwareStream(remainingMs: number, onCancel?: () => void) {
  return (_endpoint: string, _args: unknown, signal?: AbortSignal) =>
    (async function* () {
      const queue: unknown[] = [{ remainingMs }]
      let ended = signal?.aborted === true
      let notify: (() => void) | undefined
      signal?.addEventListener(
        'abort',
        () => {
          ended = true
          onCancel?.()
          notify?.()
        },
        { once: true },
      )
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()
          continue
        }
        if (ended) return
        await new Promise<void>((resolve) => {
          notify = resolve
        })
        notify = undefined
      }
    })()
}

/**
 * DSH 0.2.0-rc.2 owns the timed wait in `TimedQuestionWait`: the first Client to
 * claim it suspends the Host deadline, the claim lasts until its stream closes,
 * and only then does the Host resume counting. Every test here pins one edge of
 * that ownership boundary, because getting it wrong silently changes when a
 * question times out or leaks a claim against a live session.
 */
describe('DSH 0.2.0-rc.2 attachWait claim ownership', () => {
  it('returns the one Host-computed remaining duration and holds the claim until released', async () => {
    let cancelled = false
    const questions = repository({ openRemoteStream: abortAwareStream(4_250, () => (cancelled = true)) })

    await expect(questions.attachWait('session-1', 'call-1')).resolves.toBe(4_250)
    // Holding the claim is what pauses the Host deadline, so the stream must
    // still be open here.
    expect(cancelled).toBe(false)

    await questions.releaseWait('session-1', 'call-1')
    expect(cancelled).toBe(true)
    await questions.close()
  })

  it('collapses concurrent claims for one call onto a single upstream stream', async () => {
    let opened = 0
    let cancelled = 0
    const questions = repository({
      openRemoteStream: (endpoint, args, signal) => {
        opened += 1
        return abortAwareStream(2_500, () => (cancelled += 1))(endpoint, args, signal)
      },
    })

    // Two answer UIs attaching to the same call must not open two Host
    // claims: upstream counts claims to decide whether to run its timer, and a
    // second stream would keep the deadline suspended after the first closes.
    await expect(questions.attachWait('session-1', 'call-1')).resolves.toBe(2_500)
    await expect(questions.attachWait('session-1', 'call-1')).resolves.toBe(2_500)
    expect(opened).toBe(1)

    await questions.releaseWait('session-1', 'call-1')
    expect(cancelled).toBe(1)
    await questions.close()
  })

  it('reopens a claim after release, since the question stays answerable', async () => {
    const questions = repository({ openRemoteStream: abortAwareStream(3_000) })

    await questions.attachWait('session-1', 'call-1')
    await questions.releaseWait('session-1', 'call-1')
    // A released claim must not be remembered as still open: the user can
    // reopen the panel while the same call is still answerable.
    await expect(questions.attachWait('session-1', 'call-1')).resolves.toBe(3_000)
    await questions.close()
  })

  it('treats a closed stream as an already ended wait rather than a failure', async () => {
    const questions = repository({
      openRemoteStream: async function* () {
        await Promise.resolve()
        yield* []
      },
    })

    // Upstream yields no frame when the wait already ended, so there is no
    // countdown to start and no error to report.
    await expect(questions.attachWait('session-1', 'call-1')).resolves.toBeUndefined()
    await questions.close()
  })

  it('rejects an already-aborted caller signal without opening a Host claim', async () => {
    let opened = false
    const questions = repository({
      openRemoteStream: (endpoint, args, signal) => {
        opened = true
        return abortAwareStream(1_000)(endpoint, args, signal)
      },
    })
    const controller = new AbortController()
    controller.abort(new AppError({ code: 'REQUEST_CANCELLED', message: 'gone', retryable: false }))

    await expect(questions.attachWait('session-1', 'call-1', controller.signal)).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    })
    expect(opened).toBe(false)
    await questions.close()
  })

  it('releases every held claim on close', async () => {
    const cancelled = new Set<string>()
    const questions = repository({
      openRemoteStream: (endpoint, args, signal) =>
        abortAwareStream(9_000, () => cancelled.add(String(args.callId)))(endpoint, args, signal),
    })

    await questions.attachWait('session-1', 'call-1')
    await questions.attachWait('session-1', 'call-2')
    await expect(questions.close()).resolves.toBeUndefined()
    // A disposed adapter that left a claim attached would keep the Host
    // deadline suspended for a session nobody is viewing.
    expect([...cancelled].sort()).toEqual(['call-1', 'call-2'])
  })

  it('refuses new claims after close', async () => {
    const questions = repository({ openRemoteStream: abortAwareStream(1_000) })
    await questions.close()
    await expect(questions.attachWait('session-1', 'call-1')).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
      retryable: true,
    })
  })
})
