type RawClientRequest = {
  readonly type: 'client-request'
  readonly rpcId: string
  readonly method: string
  readonly payload: unknown
}

type RawRpcResult =
  | { readonly ok: true; readonly value?: unknown }
  | {
      readonly ok: false
      readonly error: {
        readonly code: string
        readonly message: string
        readonly details: Record<string, unknown>
      }
    }

export type RawServerResponse = {
  readonly type: 'server-response'
  readonly rpcId: string
  readonly result: RawRpcResult
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function parseRawServerResponse(value: unknown): RawServerResponse {
  const envelope = record(value)
  const result = record(envelope?.result)
  if (
    envelope?.type !== 'server-response' ||
    typeof envelope.rpcId !== 'string' ||
    result === undefined ||
    typeof result.ok !== 'boolean'
  )
    throw new Error('Malformed server-response envelope')

  if (result.ok) {
    return {
      type: 'server-response',
      rpcId: envelope.rpcId,
      result: Object.hasOwn(result, 'value') ? { ok: true, value: result.value } : { ok: true },
    }
  }

  const error = record(result.error)
  if (
    error === undefined ||
    typeof error.code !== 'string' ||
    typeof error.message !== 'string' ||
    !Object.hasOwn(error, 'details')
  )
    throw new Error('Malformed server-response error')
  const details = record(error.details)
  if (details === undefined) throw new Error('Malformed server-response error details')
  return {
    type: 'server-response',
    rpcId: envelope.rpcId,
    result: {
      ok: false,
      error: { code: error.code, message: error.message, details },
    },
  }
}

/**
 * rc.6/rc.7 still emit the settings-not-exposed error branch that later
 * removed from its generated envelope schema. Keep the current upstream
 * typed client for every success/value schema, but widen this one legacy
 * error at the transport seam so an older host is not rejected before the
 * adapter's own error mapper sees it.
 */
export async function normalizeLegacyRpcResponse(response: Response, pathname: string): Promise<Response> {
  // The legacy settings error is a 2xx envelope, while non-2xx responses are
  // the only other responses worth probing for a structured error. Avoid
  // cloning large successful exports and ordinary RPC values.
  if (response.ok && !isSettingsRpcPath(pathname)) return response
  if (!response.headers.get('content-type')?.toLocaleLowerCase().includes('json')) return response
  let value: unknown
  try {
    value = await response.clone().json()
  } catch {
    return response
  }
  if (!isLegacySettingsErrorEnvelope(value)) return response
  const envelope = value as Record<string, unknown>
  const result = envelope.result as Record<string, unknown>
  const error = result.error as Record<string, unknown>
  const normalized = {
    ...envelope,
    result: {
      ...result,
      error: { ...error, code: 'settings-rejected' },
    },
  }
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(normalized), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function isSettingsRpcPath(pathname: string): boolean {
  return pathname.startsWith('/api/settings.')
}

function isLegacySettingsErrorEnvelope(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  const result = envelope.result
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return false
  const resultRecord = result as Record<string, unknown>
  const error = resultRecord.error
  if (resultRecord.ok !== false || typeof error !== 'object' || error === null || Array.isArray(error))
    return false
  const errorRecord = error as Record<string, unknown>
  const details = errorRecord.details
  return (
    errorRecord.code === 'settings-not-exposed' &&
    typeof details === 'object' &&
    details !== null &&
    !Array.isArray(details) &&
    typeof (details as Record<string, unknown>).ns === 'string'
  )
}

export type { RawClientRequest }
