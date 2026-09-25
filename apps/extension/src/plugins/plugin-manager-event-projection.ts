import type { PluginInstallProgressView } from '@dsh-vscode/domain'

/** Convert the exact RC2 install-state event into a small safe Webview DTO. */
export function projectPluginInstallProgress(
  args: readonly unknown[],
): PluginInstallProgressView | undefined {
  const value = object(args[0])
  if (
    value === undefined ||
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    value.requestId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/u.test(value.requestId) ||
    (value.phase !== 'installing' && value.phase !== 'cancelling' && value.phase !== 'applying')
  )
    return undefined

  const attempt = object(value.attempt)
  if (attempt === undefined) {
    if (value.attempt !== undefined) return undefined
    return { requestId: value.requestId, phase: value.phase }
  }
  if (
    value.phase !== 'installing' ||
    !Number.isSafeInteger(attempt.index) ||
    !Number.isSafeInteger(attempt.total) ||
    (attempt.index as number) < 1 ||
    (attempt.total as number) < (attempt.index as number) ||
    (attempt.total as number) > 64
  )
    return undefined

  return {
    requestId: value.requestId,
    phase: value.phase,
    attemptIndex: attempt.index as number,
    attemptTotal: attempt.total as number,
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
