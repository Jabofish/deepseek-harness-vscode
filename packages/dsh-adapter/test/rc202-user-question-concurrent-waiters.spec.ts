import { describe, expect, it } from 'vitest'
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
 * DSH 0.2.0-rc.2 (retained by alpha211/alpha212) owns the timed wait in
 * `TimedQuestionWait` — upstream source at
 * upstream commit d743267388641bc76f17c45ce8b4c231aed1d32c,
 * packages/interaction/user-questions/src/timed-wait.ts, type
 * `TimedQuestionWait.attach`:
 *
 *   async *attach(signal: AbortSignal): AsyncIterable<{ remainingMs: number }> {
 *     ...
 *     const release = (): void => {
 *       if (!this.claims.delete(release)) return
 *       ...
 *       this.schedule()
 *     }
 *     this.claims.add(release)
 *     signal.addEventListener('abort', release, { once: true })
 *     ...
 *   }
 *
 *   private schedule(): void {
 *     ...
 *     if (this.signal.aborted || this.claims.size > 0) return
 *     this.timer = setTimeout(() => { this.close(this.timeout) }, ...)
 *   }
 *
 * Every `attachWait` stream therefore registers its OWN claim in a Set, the
 * Host deadline stays suspended while ANY claim exists, and one client's
 * stream cancellation removes only that client's claim
 * (`claims.delete(release)` deletes by the closure's own identity). Concurrent
 * answer UIs on one call are a supported upstream composition, and the Host
 * route anticipates them: `WebviewMessageRouter.beginQuestionWait`
 * (apps/extension/src/view/message-router.ts) keeps a per-(session, call)
 * lifetime per in-flight attach request, and
 * rc202-user-question-claim.spec.ts itself names "two answer UIs attaching to
 * the same call" as the scenario.
 *
 * These tests pin the ownership boundary between waiters. Before the fix,
 * concurrent attaches shared one upstream stream bound to the first caller's
 * AbortSignal. The shared stream must remain held until every local waiter
 * leaves, or an explicit release retires the call.
 */
describe('DSH rc202 attachWait claim ownership across concurrent waiters', () => {
  it('RED: one waiter cancelling must not release the claim another waiter still holds', async () => {
    let cancels = 0
    const questions = repository({ openRemoteStream: abortAwareStream(4_250, () => (cancels += 1)) })
    const firstWaiter = new AbortController()
    const secondWaiter = new AbortController()

    // Two independent answer UIs attach to the same timed call, each with its
    // own request lifetime — the shape `beginQuestionWait` produces for
    // concurrent attach requests on one key.
    await expect(questions.attachWait('session-1', 'call-1', firstWaiter.signal)).resolves.toBe(4_250)
    await expect(questions.attachWait('session-1', 'call-1', secondWaiter.signal)).resolves.toBe(4_250)
    expect(cancels).toBe(0)

    // The first waiter's card closes (its request is cancelled or its panel
    // unmounts). Upstream releases only that stream's claim
    // (`claims.delete(release)` by identity) and keeps the deadline
    // suspended while the second waiter's claim remains.
    firstWaiter.abort()

    // The second waiter is still viewing the question, so the upstream claim
    // it is counting on must survive: the Host must not resume the deadline
    // under an active answer UI.
    expect(cancels).toBe(0)

    // An explicit release still tears the claim down exactly once, and a
    // closed repository leaves nothing behind.
    await questions.releaseWait('session-1', 'call-1')
    expect(cancels).toBe(1)
    await questions.close()
  })
})
