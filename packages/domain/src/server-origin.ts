import type { BackendEndpoint } from './runtime.js'

export interface ServerOrigin {
  readonly host: string
  readonly port: number
  readonly baseUrl: string
}

/**
 * Parse an HTTP(S) origin into a canonical endpoint. Accepts any host — IP
 * literal or DNS name, loopback or remote. Rejects embedded credentials,
 * paths, query strings, and fragments so a configured server URL is always a
 * bare origin.
 */
export function parseServerOrigin(value: string): ServerOrigin | undefined {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.hostname === '' || parsed.username !== '' || parsed.password !== '') return undefined
  if (parsed.pathname !== '' && parsed.pathname !== '/') return undefined
  if (parsed.search !== '' || parsed.hash !== '') return undefined
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  const host = parsed.hostname
  return { host, port, baseUrl: `${parsed.protocol}//${host}:${port}` }
}

/**
 * True when the endpoint is a well-formed HTTP(S) origin whose host and port
 * agree with the parsed `baseUrl`.
 */
export function isCanonicalEndpoint(endpoint: BackendEndpoint): boolean {
  if (typeof endpoint.host !== 'string' || endpoint.host === '') return false
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535) return false
  const origin = parseServerOrigin(endpoint.baseUrl)
  return (
    origin !== undefined &&
    origin.host === endpoint.host &&
    origin.port === endpoint.port &&
    origin.baseUrl === endpoint.baseUrl
  )
}

/** Discovery remains local even when explicitly selected custom endpoints are remote. */
export function isLoopbackEndpoint(endpoint: BackendEndpoint): boolean {
  return isCanonicalEndpoint(endpoint) && (endpoint.host === '127.0.0.1' || endpoint.host === 'localhost')
}
