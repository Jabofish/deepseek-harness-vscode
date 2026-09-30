import {
  AppError,
  type TimedUserQuestionAnswer,
  type TimedUserQuestionAnswerItem,
  type UserQuestionRepository,
} from '@dsh-vscode/domain'

import type { AlphaLoopbackApiClient } from '../alpha/transport.js'
import { unwrapRpcResultValue } from '../rc6/rpc.js'

type WaitClaim = {
  readonly key: string
  readonly controller: AbortController
  readonly iterator: AsyncIterator<unknown>
  readonly externalSignal: AbortSignal | undefined
  readonly abortExternal: () => void
  opening: Promise<number | undefined>
  completion: Promise<void>
}

/** The timed userQuestions Remote surface introduced by DSH 0.2.0-rc.2. */
export class Rc202UserQuestionRepository implements UserQuestionRepository {
  private readonly claims = new Map<string, WaitClaim>()
  private closed = false

  public constructor(private readonly transport: AlphaLoopbackApiClient) {}

  public attachWait(sessionId: string, callId: string, signal?: AbortSignal): Promise<number | undefined> {
    requireIdentifier(sessionId, 'Session')
    requireIdentifier(callId, 'question call')
    if (this.closed) return Promise.reject(closedError())
    if (signal?.aborted === true)
      return Promise.reject(signal.reason instanceof Error ? signal.reason : cancelledError())

    const key = claimKey(sessionId, callId)
    const existing = this.claims.get(key)
    if (existing !== undefined) return existing.opening

    const controller = new AbortController()
    const stream = this.transport.openRemoteStream(
      'userQuestions/attachWait',
      { agentId: sessionId, callId },
      controller.signal,
    )
    const iterator = stream[Symbol.asyncIterator]()
    const claim: WaitClaim = {
      key,
      controller,
      iterator,
      externalSignal: signal,
      abortExternal: () => controller.abort(signal?.reason ?? cancelledError()),
      opening: Promise.resolve(undefined),
      completion: Promise.resolve(),
    }
    this.claims.set(key, claim)
    signal?.addEventListener('abort', claim.abortExternal, { once: true })
    claim.opening = this.openClaim(claim)
    return claim.opening
  }

  public async releaseWait(sessionId: string, callId: string): Promise<void> {
    const claim = this.claims.get(claimKey(sessionId, callId))
    if (claim === undefined) return
    this.claims.delete(claim.key)
    claim.controller.abort(cancelledError())
    const returnStream = claim.iterator.return?.()
    await Promise.allSettled([
      claim.opening,
      claim.completion,
      ...(returnStream === undefined ? [] : [returnStream]),
    ])
  }

  public async answer(
    sessionId: string,
    callId: string,
    answer: TimedUserQuestionAnswer,
    signal?: AbortSignal,
  ): Promise<boolean> {
    requireIdentifier(sessionId, 'Session')
    requireIdentifier(callId, 'question call')
    validateAnswer(answer)
    if (this.closed) throw closedError()
    if (signal?.aborted === true) throw signal.reason ?? cancelledError()

    // answer is deliberately outside the transport's idempotent retry set:
    // a timed reply is steered as a new user message and must never duplicate.
    let result: unknown
    try {
      result = await this.transport.remoteRequest<unknown>(
        'userQuestions/answer',
        { agentId: sessionId, callId, answer: copyAnswer(answer) },
        signal,
      )
    } catch (error) {
      // Upstream raises REPLY_QUEUED from one branch covering several
      // situations: this client's own earlier reply is recorded (possibly
      // optimistically, before its steer), or a reply already sits in the
      // durable Inbox. The error carries no field separating them, so a batch
      // that was not confirmed recorded must not be reported as accepted.
      //
      // The transport never hands over the raw wire code: rc202 installs
      // `normalizeRc202ErrorCode`, which maps REPLY_QUEUED to `writer-held`
      // before the AppError is built. Matching the wire spelling here would
      // read as correct while never firing in production, so the check uses
      // the normalized code and confirms via the preserved wire spelling —
      // `writer-held` alone is ambiguous, since rc.2 also normalizes
      // CALLER_NOT_LIVE and DELEGATED_CALLER onto it.
      if (error instanceof AppError && isDuplicateReplyError(error)) throw duplicateReplyQueued(error)
      throw error
    }
    const accepted = unwrapRpcResultValue<unknown>(result, 'userQuestions/answer')
    if (typeof accepted !== 'boolean') throw malformed('answer result')
    return accepted
  }

  public async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.all([...this.claims.values()].map((claim) => this.releaseWaitByClaim(claim)))
  }

  private async openClaim(claim: WaitClaim): Promise<number | undefined> {
    try {
      const opening = await claim.iterator.next()
      if (opening.done === true) {
        this.dropClaim(claim)
        return undefined
      }
      const remainingMs = waitDuration(opening.value)
      claim.completion = this.keepClaim(claim)
      return remainingMs
    } catch (error) {
      this.dropClaim(claim)
      claim.controller.abort()
      await Promise.allSettled([claim.iterator.return?.() ?? Promise.resolve()])
      throw error
    }
  }

  private async keepClaim(claim: WaitClaim): Promise<void> {
    try {
      const next = await claim.iterator.next()
      if (next.done !== true) throw malformed('attachWait stream continuation')
    } catch {
      // Stream closure, timeout, and cancellation all release the upstream claim.
      // The answerable state is read from the Session projection independently.
    } finally {
      this.dropClaim(claim)
    }
  }

  private async releaseWaitByClaim(claim: WaitClaim): Promise<void> {
    this.claims.delete(claim.key)
    claim.controller.abort(cancelledError())
    const returnStream = claim.iterator.return?.()
    await Promise.allSettled([
      claim.opening,
      claim.completion,
      ...(returnStream === undefined ? [] : [returnStream]),
    ])
  }

  private dropClaim(claim: WaitClaim): void {
    claim.externalSignal?.removeEventListener('abort', claim.abortExternal)
    if (this.claims.get(claim.key) === claim) this.claims.delete(claim.key)
  }
}

function validateAnswer(answer: TimedUserQuestionAnswer): void {
  if (
    !isRecord(answer) ||
    !Array.isArray(answer.answers) ||
    answer.answers.length === 0 ||
    answer.answers.length > 64
  )
    throw malformed('answer request')
  const ids = new Set<string>()
  for (const item of answer.answers) {
    if (
      !isRecord(item) ||
      !isNonEmptyString(item.id) ||
      ids.has(item.id) ||
      !Array.isArray(item.selected) ||
      item.selected.length > 64 ||
      !item.selected.every(isBoundedString) ||
      (item.custom !== undefined && !isBoundedString(item.custom))
    )
      throw malformed('answer request')
    ids.add(item.id)
  }
}

function copyAnswer(answer: TimedUserQuestionAnswer): TimedUserQuestionAnswer {
  return {
    answers: answer.answers.map((item: TimedUserQuestionAnswerItem) => ({
      id: item.id,
      selected: [...item.selected],
      ...(item.custom === undefined ? {} : { custom: item.custom }),
    })),
  }
}

function waitDuration(value: unknown): number {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !Number.isSafeInteger(value.remainingMs) ||
    typeof value.remainingMs !== 'number' ||
    value.remainingMs < 0 ||
    value.remainingMs > 2_147_483_647
  )
    throw malformed('attachWait frame')
  return value.remainingMs
}

function requireIdentifier(value: string, part: string): void {
  if (!isNonEmptyString(value) || value.length > 512)
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: `A DSH ${part} is required for this question operation.`,
      retryable: false,
    })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100_000
}

function claimKey(sessionId: string, callId: string): string {
  return JSON.stringify([sessionId, callId])
}

function malformed(part: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed rc202 user question ${part}.`,
    retryable: false,
  })
}

function closedError(): AppError {
  return new AppError({
    code: 'BACKEND_UNREACHABLE',
    message: 'The DSH user question connection has closed.',
    retryable: true,
  })
}

/**
 * DSH already holds a reply for this call, so the question can no longer take
 * this batch. Reported rather than silently accepted: upstream raises this
 * before it records the batch, and the held reply may be this client's own
 * earlier one or another client's, which only upstream can tell apart.
 */
/**
 * The code the transport actually surfaces for upstream's `REPLY_QUEUED`.
 * `normalizeRc202ErrorCode` maps the wire spelling onto this local equivalent
 * (`rc202/error-vocabulary.ts`), so the repository can only ever observe this
 * value directly. Kept beside the check so the two cannot drift apart silently.
 */
const DUPLICATE_REPLY_RPC_CODE = 'writer-held'
const DUPLICATE_REPLY_WIRE_CODE = 'REPLY_QUEUED'

/**
 * True only for upstream's duplicate-reply condition. `writer-held` is shared
 * with the caller-liveness failures, which are a different problem and must
 * keep their own diagnosis, so the preserved wire spelling has to agree.
 */
function isDuplicateReplyError(error: AppError): boolean {
  return (
    error.context?.rpcCode === DUPLICATE_REPLY_RPC_CODE &&
    error.context?.wireCode === DUPLICATE_REPLY_WIRE_CODE
  )
}

function duplicateReplyQueued(cause: AppError): AppError {
  return new AppError({
    code: 'STALE_INTERACTION',
    message: 'DSH already holds a reply for this question, so this answer was not recorded.',
    retryable: false,
    context: {
      rpcCode: DUPLICATE_REPLY_RPC_CODE,
      rpcMethod: 'userQuestions/answer',
      // The wire spelling is preserved so diagnostics still name the upstream
      // condition rather than only its local normalization.
      wireCode: cause.context?.wireCode ?? DUPLICATE_REPLY_WIRE_CODE,
    },
  })
}

function cancelledError(): AppError {
  return new AppError({
    code: 'REQUEST_CANCELLED',
    message: 'The DSH user question request was cancelled.',
    retryable: false,
  })
}
