import { AppError } from '@dsh-vscode/domain'

import {
  isNonEmptyString,
  isNonEmptyStringArray,
  isPlainRecord,
  malformedResponse,
  recordOrUndefined,
  type AlphaErrorCodeNormalizer,
} from './remote-mux.js'

export type AlphaSuccess = { readonly ok: true; readonly value?: unknown }
export type AlphaFailure = {
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
    readonly details: Record<string, unknown>
  }
}
export type AlphaResult = AlphaSuccess | AlphaFailure
export type AlphaResponse = { readonly rpcId: string; readonly result: AlphaResult }
export type LegacyResponse = { readonly rpcId: string; readonly result: AlphaResult }

export function mapEmit(event: unknown, args: readonly unknown[]): readonly unknown[] {
  switch (event) {
    case 'api-session/added': {
      const summary = recordOrUndefined(args[0])
      if (
        args.length !== 1 ||
        summary === undefined ||
        !isNonEmptyString(summary.sessionId) ||
        typeof summary.blank !== 'boolean' ||
        (summary.parentSessionId !== undefined && !isNonEmptyString(summary.parentSessionId)) ||
        (summary.origin !== undefined && summary.origin !== 'subagent') ||
        (summary.agentAvailable !== undefined && typeof summary.agentAvailable !== 'boolean') ||
        (summary.cwd !== undefined && typeof summary.cwd !== 'string') ||
        (summary.agentPreset !== undefined && typeof summary.agentPreset !== 'string')
      )
        throw malformedResponse('$events api-session/added')
      return [
        {
          type: 'host/session-added',
          sessionId: summary.sessionId,
          blank: summary.blank,
          ...(summary.agentAvailable === undefined ? {} : { agentAvailable: summary.agentAvailable }),
          ...(summary.parentSessionId === undefined ? {} : { parentSessionId: summary.parentSessionId }),
          ...(summary.origin === undefined ? {} : { origin: summary.origin }),
          ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
          ...(summary.agentPreset === undefined ? {} : { agentPreset: summary.agentPreset }),
        },
      ]
    }
    case 'api-session/removed':
      if (args.length !== 1 || !isNonEmptyString(args[0]))
        throw malformedResponse('$events api-session/removed')
      return [{ type: 'host/session-removed', sessionId: args[0] }]
    case 'api-session/status':
      if (args.length !== 2 || !isNonEmptyString(args[0]) || typeof args[1] !== 'boolean')
        throw malformedResponse('$events api-session/status')
      return [{ type: 'host/session-status', sessionId: args[0], running: args[1] }]
    case 'api-session/activity':
      if (
        args.length !== 2 ||
        !isNonEmptyString(args[0]) ||
        !Number.isSafeInteger(args[1]) ||
        (args[1] as number) < 0
      )
        throw malformedResponse('$events api-session/activity')
      return [{ type: 'host/session-activity', sessionId: args[0], updatedAt: args[1] }]
    case 'api-session/error':
      if (args.length !== 2 || !isNonEmptyString(args[0]) || typeof args[1] !== 'string')
        throw malformedResponse('$events api-session/error')
      return [{ type: 'host/agent-error', sessionId: args[0], message: args[1] }]
    case 'agent-preset/selected':
      if (args.length !== 2 || !isNonEmptyString(args[0]) || !isNonEmptyString(args[1]))
        throw malformedResponse('$events agent-preset/selected')
      return [
        {
          type: 'session/event',
          sessionId: args[0],
          event: { type: 'agent-preset/selected', data: { agentPreset: args[1] } },
        },
      ]
    default:
      return [{ type: 'host/remote-event', event, args }]
  }
}

type AlphaProviderInfo = Record<string, unknown> & { readonly id: string; readonly name: string }

export type AlphaConfigurableProvider = Record<string, unknown> & {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly declared?: boolean
}

function validAlphaProviderInfo(value: unknown): value is AlphaProviderInfo {
  const row = recordOrUndefined(value)
  return row !== undefined && isNonEmptyString(row.id) && isNonEmptyString(row.name)
}

function validAlphaConfigurableProvider(value: unknown): value is AlphaConfigurableProvider {
  const row = recordOrUndefined(value)
  return (
    row !== undefined &&
    isNonEmptyString(row.provider) &&
    isNonEmptyString(row.displayName) &&
    isNonEmptyString(row.settingsNs) &&
    isNonEmptyStringArray(row.settingsPath) &&
    (row.declared === undefined || typeof row.declared === 'boolean')
  )
}

export function alphaProviderInfoList(value: unknown): readonly AlphaProviderInfo[] {
  if (!Array.isArray(value) || !value.every(validAlphaProviderInfo))
    throw malformedResponse('llm/listProviders')
  return value
}

export function alphaConfigurableProviderList(value: unknown): readonly AlphaConfigurableProvider[] {
  if (!Array.isArray(value) || !value.every(validAlphaConfigurableProvider))
    throw malformedResponse('llm/listConfigurableProviders')
  return value
}

export function validAlphaResult(value: unknown): value is AlphaResult {
  const record = recordOrUndefined(value)
  if (record?.ok === true) return true
  const error = recordOrUndefined(record?.error)
  return (
    record?.ok === false &&
    error !== undefined &&
    typeof error.code === 'string' &&
    typeof error.message === 'string' &&
    isPlainRecord(error.details)
  )
}

export function normalizeAlphaResult(
  result: AlphaResult,
  normalizeErrorCode?: AlphaErrorCodeNormalizer,
): AlphaResult {
  if (result.ok || normalizeErrorCode === undefined) return result
  const wireCode = result.error.code
  const code = normalizeErrorCode(wireCode, result.error.details)
  return {
    ...result,
    error: {
      ...result.error,
      code,
      // Several distinct wire codes collapse onto one local code (for example
      // rc.2 maps both REPLY_QUEUED and CALLER_NOT_LIVE to `writer-held`).
      // Callers that must tell the underlying condition apart would otherwise
      // have to guess, so the original spelling is retained alongside it.
      details: code === wireCode ? result.error.details : { ...result.error.details, wireCode },
    },
  }
}

export function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
}

export function withoutKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const excluded = new Set(keys)
  return Object.fromEntries(Object.entries(value).filter(([name]) => !excluded.has(name)))
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new AppError({ code: 'INVALID_CONFIGURATION', message: `${label} is required.`, retryable: false })
  return value
}

export function assertRemoteEndpoint(endpoint: string): void {
  const segments = endpoint.split('/')
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === '' || segment === '.' || segment === '..' || !/^[A-Za-z0-9_$.-]+$/u.test(segment),
    )
  )
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The alpha DSH Remote endpoint is invalid.',
      retryable: false,
    })
}

function rejectionError(reason: unknown): Error {
  // AbortSignal and WebSocket failure paths can carry arbitrary reasons. Keep
  // existing Error instances (including AppError classifications) intact, and
  // retain non-Error values as causes while satisfying Promise's Error contract.
  return reason instanceof Error ? reason : new Error('The alpha DSH stream failed.', { cause: reason })
}

export function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(rejectionError(signal.reason))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(rejectionError(signal.reason))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(rejectionError(error))
      },
    )
  })
}
