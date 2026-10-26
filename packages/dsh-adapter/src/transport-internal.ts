import { AppError, isCanonicalEndpoint, type BackendEndpoint } from '@dsh-vscode/domain'

import type { RetryPolicy } from './contracts.js'
import { cancelled, normalizeTransportError } from './transport-errors.js'

/**
 * Callers never read a non-2xx body, and an unconsumed fetch body pins its
 * socket instead of returning it to the pool. Release it explicitly so
 * discovery sweeps and retry loops cannot accumulate stalled connections.
 */
export async function releaseUnreadBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    /* releasing the connection is best effort */
  }
}

/** Upper bound for a single JSON RPC response body read into memory. */
export const MAX_RPC_RESPONSE_BYTES = 64 * 1024 * 1024

/**
 * Read and parse a JSON response body while refusing bodies beyond `maxBytes`.
 * A malicious or misbehaving DSH must not be able to exhaust the Extension Host
 * by streaming an unbounded `response.json()` payload.
 */
export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  method: string,
): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw oversizedBody(method)
  let text = ''
  let size = 0
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) throw oversizedBody(method)
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    try {
      return JSON.parse(text) as unknown
    } catch (error) {
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: `The DSH response for ${method} was not valid JSON.`,
        retryable: false,
        cause: error,
      })
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function oversizedBody(method: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `The DSH response for ${method} exceeded the allowed size.`,
    retryable: false,
  })
}

export function assertValidEndpoint(endpoint: BackendEndpoint): void {
  if (!isCanonicalEndpoint(endpoint)) {
    throw new AppError({
      code: 'INVALID_ENDPOINT',
      message: 'DSH connections must use a validated HTTP(S) endpoint.',
      retryable: false,
    })
  }
}

export function closedConnectionError(): AppError {
  return new AppError({
    code: 'BACKEND_UNREACHABLE',
    message: 'The DSH connection is closed.',
    retryable: false,
  })
}

export function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

export function mergeSignals(first: AbortSignal | null | undefined, second: AbortSignal): AbortSignal {
  return first === undefined || first === null ? second : AbortSignal.any([first, second])
}

export function combineSignals(...signals: (AbortSignal | undefined | number)[]): AbortSignal {
  const sources = signals.filter(
    (value): value is AbortSignal => typeof value !== 'number' && value !== undefined,
  )
  const timeout = signals.find((value): value is number => typeof value === 'number')
  if (timeout !== undefined) sources.push(AbortSignal.timeout(timeout))
  return sources.length === 1 ? (sources[0] as AbortSignal) : AbortSignal.any(sources)
}

export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw cancelled(signal.reason)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onAbort = (): void => finish(() => reject(cancelled(signal?.reason)))
    const timer = setTimeout(() => finish(resolve), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Shared exponential-backoff retry loop for loopback and alpha transports.
 * Only allowlisted idempotent methods may retry, and a closed transport never
 * retries: the caller supplies both predicates so each client keeps its own
 * method vocabulary while the attempt/backoff/abort sequencing stays in one
 * place.
 */
export async function withTransportRetry<T>(options: {
  method: string
  operation: () => Promise<T>
  signal?: AbortSignal | undefined
  /** Already merged with the client's closed signal by the caller. */
  retrySignal: AbortSignal
  retryPolicy: RetryPolicy
  isIdempotent: (method: string) => boolean
  isClosed: () => boolean
}): Promise<T> {
  const attempts = Math.max(1, options.retryPolicy.maximumAttempts)
  let last: AppError | undefined
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted === true) throw cancelled(options.signal.reason)
    if (options.isClosed()) throw closedConnectionError()
    try {
      return await options.operation()
    } catch (error) {
      const normalized = normalizeTransportError(options.method, error, options.signal)
      last = normalized
      if (signalIsAborted(options.signal)) throw normalized
      if (options.isClosed()) throw closedConnectionError()
      if (!normalized.retryable || !options.isIdempotent(options.method) || attempt + 1 >= attempts)
        throw normalized
      try {
        await delay(
          Math.min(options.retryPolicy.maximumDelayMs, options.retryPolicy.baseDelayMs * 2 ** attempt),
          options.retrySignal,
        )
      } catch (error) {
        if (signalIsAborted(options.signal)) throw cancelled(options.signal?.reason)
        if (options.isClosed()) throw closedConnectionError()
        throw error
      }
    }
  }
  throw (
    last ??
    new AppError({
      code: 'BACKEND_UNREACHABLE',
      message: `The DSH request ${options.method} failed.`,
      retryable: true,
    })
  )
}

export const IDEMPOTENT_METHODS = new Set([
  'host.describe',
  'command.list',
  'session.list',
  'session.search',
  'session.history',
  'session.attachment',
  'session.models',
  'workspace.list',
  'skill.list',
  'agentPreset.list',
  'llm.providers',
  'llm.models',
  'settings.describe',
  'credentials.describe',
  'subagent.list',
  'subagent.history',
  'schedule/catalog',
  'schedule/list',
  'schedule/history',
])

export const ALPHA_IDEMPOTENT_METHODS = new Set([
  'session.list',
  'session.search',
  'session.history',
  'session.models',
  'subagent.list',
  'subagent.history',
  'host.listDirectory',
  'workspace.list',
  'skill.list',
  'agentPreset.list',
  'agentPreset.read',
  'settings.describe',
  'credentials.describe',
  'llm.providers',
  'llm.models',
  'commands/list',
  'fileReferences/list',
  'sessionReferenceResolver/candidates',
  'messageFeedback/list',
  'pluginInventory/list',
  'agentPresets/list',
  'agentPresets/read',
  'settings/describe',
  'settings/canOpenAgentPresetDirectory',
  'credentials/describe',
  'llm/listProviders',
  'llm/listConfigurableProviders',
  'session/list',
  'session/search',
  'session.attachment',
  'session/modelCatalog',
  'session/page',
  'session/follow',
  'workspace/follow',
  'directoryPicker/list',
  'subagents/list',
  'subagents/catalog',
  // DSH 0.1.7-rc.2 Schedule Remote reads are safe to retry. Keep the two
  // mutating schedule endpoints out of this allowlist.
  'schedule/catalog',
  'schedule/list',
  'schedule/history',
])

export function isAlphaIdempotentMethod(method: string): boolean {
  return ALPHA_IDEMPOTENT_METHODS.has(method)
}
