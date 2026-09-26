const DEFINITE_SCHEDULE_PROMPT_REJECTION_CODES = new Set([
  'AUTH_REQUIRED',
  'BACKEND_BUSY',
  'BACKEND_UNREACHABLE',
  'CAPABILITY_UNAVAILABLE',
  'CONTEXT_EXPIRED',
  'CONTEXT_LIMIT',
  'CONTEXT_STALE',
  'FEATURE_DISABLED',
  'INVALID_CONFIGURATION',
  'NO_RUNNING_INSTANCE',
  'PATH_NOT_ALLOWED',
  'PERMISSION_DENIED',
])

export function isDefinitePromptRejection(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) return false
  const details = reason as { readonly code?: unknown; readonly retryable?: unknown }
  return (
    typeof details.code === 'string' &&
    details.retryable === false &&
    DEFINITE_SCHEDULE_PROMPT_REJECTION_CODES.has(details.code)
  )
}
