import type { BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

/**
 * Shared fixture helpers for per-version contract specs. Every pinned DSH
 * version probes and answers over the same loopback JSON-RPC wire, so the
 * request/response shims live here instead of being copied into each file.
 * Specs import the variant that matches their wire shape under their local
 * name (`rpcResponse as response` for raw results, `wrappedResponse as
 * response` for `{ ok, value }` envelopes) so call sites stay untouched.
 */

export const endpoint: BackendEndpoint = {
  host: '127.0.0.1',
  port: 4567,
  baseUrl: 'http://127.0.0.1:4567',
}

export function candidate(runtimeVersion: string): BackendCandidate {
  return { endpoint, source: 'configured', runtimeVersion, confidence: 1 }
}

export function bodyText(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('test request body is not a string')
  return init.body
}

/** A `server-response` whose `result` is carried verbatim (raw RPC result). */
export function rpcResponse(init: RequestInit | undefined, result: unknown): Response {
  const request = JSON.parse(bodyText(init)) as { readonly rpcId?: string }
  return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result }), {
    headers: { 'content-type': 'application/json' },
  })
}

/** A `server-response` whose `result` is the `{ ok, value }` Remote envelope. */
export function wrappedResponse(init: RequestInit | undefined, value: unknown): Response {
  const request = JSON.parse(bodyText(init)) as { readonly rpcId?: string }
  return new Response(
    JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }),
    { headers: { 'content-type': 'application/json' } },
  )
}

export function failureResponse(
  init: RequestInit | undefined,
  code: string,
  message = 'upstream failure',
  details: Readonly<Record<string, unknown>> = {},
): Response {
  const request = JSON.parse(bodyText(init)) as { readonly rpcId?: string }
  return new Response(
    JSON.stringify({
      type: 'server-response',
      rpcId: request.rpcId,
      result: { ok: false, error: { code, message, details } },
    }),
    { headers: { 'content-type': 'application/json' } },
  )
}

/** Standard per-version transport options used by the contract specs. */
export function transportOptions(fetch: typeof globalThis.fetch): {
  requestTimeoutMs: number
  retryPolicy: { maximumAttempts: number; baseDelayMs: number; maximumDelayMs: number }
  fetch: typeof globalThis.fetch
} {
  return {
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch,
  }
}
