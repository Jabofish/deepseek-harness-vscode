import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@dsh-vscode/domain'
import { normalizeAlphaResult } from '../src/versions/alpha/transport-support.js'
import { normalizeRc202ErrorCode } from '../src/versions/rc202/error-vocabulary.js'
import { Rc202UserQuestionRepository } from '../src/versions/rc202/user-question-repository.js'
import type { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'

function repository(transport: Partial<AlphaLoopbackApiClient>): Rc202UserQuestionRepository {
  return new Rc202UserQuestionRepository(transport as AlphaLoopbackApiClient)
}

/**
 * Reproduces what the transport actually hands a Remote caller for a wire
 * error. `Rc202VersionAdapter` installs `normalizeRc202ErrorCode` as the
 * transport's `normalizeErrorCode` (`rc202/adapter.ts`), so the code on the
 * AppError is the *normalized* one, never the raw DSH code. Building the
 * rejection by hand with `rpcCode: 'REPLY_QUEUED'` would test a shape the
 * transport can never produce.
 */
function wireRejection(wireCode: string): AppError {
  const normalized = normalizeAlphaResult(
    { ok: false, error: { code: wireCode, message: 'a reply is already queued', details: {} } },
    normalizeRc202ErrorCode,
  )
  if (normalized.ok) throw new Error('probe expected a failed result')
  const wireCodeInDetails = wireCodeIn(normalized.error.details)
  return new AppError({
    code: 'BACKEND_BUSY',
    message: 'The DSH session is currently owned by another DSH writer.',
    retryable: true,
    context: {
      rpcCode: normalized.error.code,
      ...(wireCodeInDetails === undefined ? {} : { wireCode: wireCodeInDetails }),
      rpcMethod: 'userQuestions/answer',
    },
  })
}

function wireCodeIn(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const value = (details as { wireCode?: unknown }).wireCode
  return typeof value === 'string' ? value : undefined
}

/**
 * DSH 0.2.0-rc.2 throws `REPLY_QUEUED` ("a reply is already queued for this
 * question") from one branch that covers two different situations:
 *
 *   1. this client's own earlier answer is still recorded, and
 *   2. some other reply for the call already sits in the durable Inbox.
 *
 * Upstream's error carries no field separating them. Reporting `true` (the
 * "accepted" result) for either case would tell the user their batch was
 * recorded when upstream may have discarded it as a duplicate, so the
 * duplicate surfaces as a stale, non-retryable interaction instead. The
 * Webview derives its read-only queued state from the Inbox projection, not
 * from this return value.
 *
 * The wire code is `REPLY_QUEUED`; the transport normalizes it to
 * `writer-held` before the repository sees it, so the repository must
 * recognise the normalized code.
 */
describe('DSH 0.2.0-rc.2 answer duplicate receipt', () => {
  it('recognises the normalized code the transport delivers for a queued reply', () => {
    // Guards against the regression this suite was written for: `REPLY_QUEUED`
    // never reaches the repository, only its normalized local equivalent does.
    const rejection = wireRejection('REPLY_QUEUED')
    expect(rejection.context?.rpcCode).toBe('writer-held')
    expect(rejection.context?.wireCode).toBe('REPLY_QUEUED')
  })

  it('reports an already-queued reply as a stale interaction, never as accepted', async () => {
    const questions = repository({ remoteRequest: () => Promise.reject(wireRejection('REPLY_QUEUED')) })

    await expect(
      questions.answer('session-1', 'call-1', { answers: [{ id: 'scope', selected: ['workspace'] }] }),
    ).rejects.toMatchObject({
      code: 'STALE_INTERACTION',
      retryable: false,
      context: { rpcMethod: 'userQuestions/answer' },
    })
    await questions.close()
  })

  it('still returns the Host boolean for a genuinely accepted batch', async () => {
    const questions = repository({
      remoteRequest: <TResponse>() => Promise.resolve({ ok: true, value: true } as TResponse),
    })
    await expect(
      questions.answer('session-1', 'call-1', { answers: [{ id: 'scope', selected: ['workspace'] }] }),
    ).resolves.toBe(true)
    await questions.close()
  })

  it('returns false, not a fabricated success, when upstream declines the call', async () => {
    const questions = repository({
      remoteRequest: <TResponse>() => Promise.resolve({ ok: true, value: false } as TResponse),
    })
    await expect(
      questions.answer('session-1', 'call-1', { answers: [{ id: 'scope', selected: ['workspace'] }] }),
    ).resolves.toBe(false)
    await questions.close()
  })

  it('does not disguise an unrelated writer conflict as an already-answered question', async () => {
    // CALLER_NOT_LIVE normalizes onto the same `writer-held` as REPLY_QUEUED,
    // so a check that keyed on the normalized code alone would wrongly tell the
    // user their answer was recorded. It describes a different failure and
    // must keep its own diagnosis.
    const questions = repository({
      remoteRequest: () => Promise.reject(wireRejection('CALLER_NOT_LIVE')),
    })

    await expect(
      questions.answer('session-1', 'call-1', { answers: [{ id: 'scope', selected: ['workspace'] }] }),
    ).rejects.toMatchObject({ code: 'BACKEND_BUSY' })
    await questions.close()
  })

  it('never retries a non-idempotent answer', async () => {
    const remoteRequest = vi.fn(() => Promise.reject(wireRejection('REPLY_QUEUED')))
    const questions = repository({ remoteRequest })

    await expect(
      questions.answer('session-1', 'call-1', { answers: [{ id: 'scope', selected: ['workspace'] }] }),
    ).rejects.toMatchObject({ code: 'STALE_INTERACTION' })
    // A steered timed reply must never duplicate, so the adapter issues
    // exactly one Remote call whatever the outcome.
    expect(remoteRequest).toHaveBeenCalledTimes(1)
    await questions.close()
  })
})
