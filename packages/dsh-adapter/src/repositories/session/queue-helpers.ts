import {
  AppError,
  type PromptAttachment,
  type PromptInput,
  type QueuedInput,
  type RunningInputMode,
} from '@dsh-vscode/domain'
import { asRecord } from './configuration.js'
import { malformedSessionResponse } from './responses.js'

export function findNewQueuedInput(
  items: readonly QueuedInput[] | undefined,
  beforeIds: ReadonlySet<string>,
  input: PromptInput,
  mode: RunningInputMode,
  rpcId?: string,
): QueuedInput | undefined {
  const candidates = [...(items ?? [])]
    .reverse()
    .filter((item) => !beforeIds.has(item.id) && item.mode === mode)
  if (rpcId !== undefined) {
    const correlated = candidates.find((item) => item.rpcId === rpcId)
    if (correlated !== undefined) return correlated
  }
  return (
    candidates.find((item) => item.text === input.text) ??
    (input.attachments.length > 0 ? candidates[0] : undefined)
  )
}

export const QUEUE_IDENTITY_TIMEOUT_MS = 2_000
export const QUEUE_IDENTITY_GRACE_MS = 30_000
/** Bound for waiting on the subscription's queue baseline before a read fails. */
export const QUEUE_BASELINE_TIMEOUT_MS = 2_000

export function queuedPromptKey(input: PromptInput, mode: RunningInputMode): string {
  const value = `${mode}\u0000${input.text}\u0000${input.attachments
    .map((attachment) => `${attachment.name}\u0000${attachment.mimeType ?? ''}\u0000${attachment.uri}`)
    .join('\u0001')}`
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return `${input.sessionId}\u0000${mode}\u0000${hash >>> 0}`
}

export function assertAccepted(value: unknown, method: string): void {
  if (asRecord(value).accepted === true) return
  throw malformedSessionResponse(`${method} receipt`)
}

/**
 * Whether a failed Steer already reached its goal.
 *
 * Steering is convergent: an item the agent has claimed
 * (`queue-item-not-found`) and a turn that stopped accepting steering
 * (`steer-unavailable`) both mean the row is no longer pending, which is the
 * state the caller asked for. The official client treats exactly these two as
 * success, and a user gesture that races the host — clicking Steer as the turn
 * ends, or steering a stale row a second time — must not report a failure.
 */
export function isSettledSteer(error: unknown): boolean {
  if (!(error instanceof AppError)) return false
  const code = error.context?.rpcCode
  return code === 'queue-item-not-found' || code === 'steer-unavailable'
}

export function cancelledQueueMutation(): AppError {
  return new AppError({
    code: 'REQUEST_CANCELLED',
    message: 'The queue operation was cancelled.',
    retryable: false,
  })
}

export function rejectQueueMutationOnAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(cancelledQueueMutation())
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      cleanup()
      reject(cancelledQueueMutation())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

export function assertPromptContent(text: string, attachments: readonly PromptAttachment[]): void {
  if (text.trim() !== '' || attachments.length > 0) return
  throw new AppError({
    code: 'INVALID_CONFIGURATION',
    message: 'Prompt content must include non-whitespace text or an attachment.',
    retryable: false,
  })
}

export function isPermissionPresetId(value: string): boolean {
  // rc.6 exposes this as a one-token slash command. Reject control/whitespace
  // and separators before any other setting is mutated.
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
}
