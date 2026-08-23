import { AppError, type AppErrorCode } from '@dsh-vscode/domain'

import { redactText } from './redaction.js'

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429])

/** Convert a fetch failure into a stable, redacted Extension Host error. */
export function normalizeTransportError(method: string, error: unknown, signal?: AbortSignal): AppError {
  // Cancellation wins over any in-flight failure class: an HTTP error racing
  // the caller's abort is still a cancelled request for the caller.
  if (signal?.aborted === true) return cancelled(signal.reason)
  if (error instanceof AppError) return error

  if (isTimeoutError(error))
    return new AppError({
      code: 'BACKEND_UNREACHABLE',
      message: `The DSH request ${method} timed out.`,
      retryable: true,
      context: { method, timedOut: true },
      cause: error,
    })

  if (isAbortError(error))
    return new AppError({
      code: 'BACKEND_UNREACHABLE',
      message: `The DSH request ${method} was interrupted by the transport.`,
      retryable: true,
      context: { method },
      cause: error,
    })

  const detail = safeErrorDetail(error)
  return new AppError({
    code: 'BACKEND_UNREACHABLE',
    message:
      detail === undefined
        ? `The DSH request ${method} failed.`
        : `The DSH request ${method} failed: ${detail}`,
    retryable: true,
    context: { method },
    cause: error,
  })
}

/** Map an HTTP response without exposing the response body to the caller. */
export function httpFailure(method: string, status: number, fallbackCode?: AppErrorCode): AppError {
  const retryable = status >= 500 || TRANSIENT_HTTP_STATUSES.has(status)
  const code = fallbackCode ?? httpStatusCode(status)
  const message =
    fallbackCode === 'EXPORT_FAILED'
      ? `The DSH export request failed (HTTP ${status}).`
      : `The DSH request ${method} failed (HTTP ${status}).`
  return new AppError({
    code,
    message,
    retryable,
    context: { method, status },
  })
}

export function cancelled(cause: unknown): AppError {
  return new AppError({
    code: 'REQUEST_CANCELLED',
    message: 'The DSH request was cancelled.',
    retryable: false,
    cause,
  })
}

function httpStatusCode(status: number): AppErrorCode {
  if (status === 401 || status === 403) return 'PERMISSION_DENIED'
  if (status >= 400 && status < 500 && !TRANSIENT_HTTP_STATUSES.has(status)) {
    return status === 404 || status === 405 || status === 426
      ? 'CAPABILITY_UNAVAILABLE'
      : 'INVALID_CONFIGURATION'
  }
  return 'BACKEND_UNREACHABLE'
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'TimeoutError'
    : error instanceof Error && error.name === 'TimeoutError'
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError'
}

function safeErrorDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const detail = redactText(error.message, 240)
  return detail === '' ? undefined : detail
}
