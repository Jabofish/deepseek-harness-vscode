import { lookup } from 'node:dns/promises'
import { createHash } from 'node:crypto'
import { isIP, type LookupFunction } from 'node:net'
import { Agent } from 'undici'
import WebSocket from 'ws'
import {
  AppError,
  isCanonicalEndpoint,
  isLoopbackEndpoint,
  parseServerOrigin,
  type BackendEndpoint,
} from '@dsh-vscode/domain'
import type { AlphaWebSocketConstructor } from '@dsh-vscode/dsh-adapter'

export interface ResolvedEndpointAddress {
  readonly address: string
  readonly family: 4 | 6
}

export interface EndpointNetworkDependencies {
  readonly fetch?: typeof globalThis.fetch
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedEndpointAddress[]>
}

interface EndpointNetworkSession {
  readonly endpoint: BackendEndpoint
  readonly lookup: LookupFunction
  readonly agent: Agent
  readonly abort: AbortController
  readonly sockets: Set<WebSocket>
}

/** Remote origins only become dialable after Host authorization, with DNS pinned per connection. */
export class EndpointNetwork {
  private readonly sessions = new Map<string, EndpointNetworkSession>()
  private readonly fetcher: typeof globalThis.fetch
  private readonly resolver: (hostname: string) => Promise<readonly ResolvedEndpointAddress[]>
  private disposed = false

  public constructor(dependencies: EndpointNetworkDependencies = {}) {
    this.fetcher = dependencies.fetch ?? globalThis.fetch
    this.resolver = dependencies.resolve ?? resolveAddresses
  }

  public async prepare(
    endpoint: BackendEndpoint,
    allowInsecureHttp: boolean,
    signal: AbortSignal,
    expectedAddresses?: string,
  ): Promise<string> {
    signal.throwIfAborted()
    if (this.disposed || !isCanonicalEndpoint(endpoint)) throw invalidEndpoint()
    const url = new URL(endpoint.baseUrl)
    if (!isLoopbackEndpoint(endpoint) && url.protocol === 'http:' && !allowInsecureHttp) {
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'Remote HTTP requires explicit approval because credentials and messages are not encrypted.',
        retryable: false,
      })
    }
    const host = endpoint.host.replace(/^\[|\]$/gu, '')
    const pendingAddresses =
      isIP(host) === 0
        ? this.resolver(host)
        : Promise.resolve([{ address: host, family: isIP(host) === 4 ? (4 as const) : (6 as const) }])
    const addresses = await waitForSignal(pendingAddresses, signal)
    signal.throwIfAborted()
    if (this.disposed) throw invalidEndpoint()
    if (
      addresses.length === 0 ||
      addresses.some(
        (entry) =>
          isIP(entry.address) !== entry.family ||
          (isLoopbackEndpoint(endpoint)
            ? !isLoopbackAddress(entry.address)
            : isDisallowedRemoteAddress(entry.address)),
      )
    )
      throw invalidEndpoint()
    const fingerprint = createHash('sha256')
      .update(
        addresses
          .map((entry) => `${entry.family}:${entry.address}`)
          .sort()
          .join('\n'),
      )
      .digest('hex')
    if (expectedAddresses !== undefined && fingerprint !== expectedAddresses) {
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message:
          'The remote HTTP address changed. Authorize the endpoint again before sending credentials over the new connection.',
        retryable: false,
      })
    }
    const pinnedLookup: LookupFunction = (_hostname, options, callback): void => {
      if (options.all === true)
        callback(
          null,
          addresses.map((entry) => ({ ...entry })),
        )
      else {
        const chosen = addresses.find(
          (entry) => options.family === undefined || options.family === 0 || options.family === entry.family,
        )
        if (chosen === undefined)
          callback(
            Object.assign(new Error('No validated address for the requested family.'), { code: 'ENOTFOUND' }),
            '',
          )
        else callback(null, chosen.address, chosen.family)
      }
    }
    await this.release(endpoint)
    signal.throwIfAborted()
    this.sessions.set(endpoint.baseUrl, {
      endpoint,
      lookup: pinnedLookup,
      agent: new Agent({
        connect: { lookup: pinnedLookup, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      }),
      abort: new AbortController(),
      sockets: new Set(),
    })
    return fingerprint
  }

  public readonly fetch: typeof globalThis.fetch = (input, init): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const endpoint = parseServerOrigin(url.origin)
    if (this.disposed || endpoint === undefined || url.username !== '' || url.password !== '')
      return Promise.reject(invalidEndpoint())
    const session = this.sessions.get(endpoint.baseUrl)
    if (session === undefined) {
      if (!isLoopbackEndpoint(endpoint) || url.protocol !== 'http:') return Promise.reject(invalidEndpoint())
      if (endpoint.host === 'localhost') {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : AbortSignal.timeout(2_000))
        return this.prepare(endpoint, false, signal).then(() => this.fetch(input, init))
      }
      return this.fetcher(input, { ...init, redirect: init?.redirect === 'manual' ? 'manual' : 'error' })
    }
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const options: RequestInit & { readonly dispatcher: Agent } = {
      ...init,
      dispatcher: session.agent,
      redirect: init?.redirect === 'manual' ? 'manual' : 'error',
      signal:
        requestSignal === undefined
          ? session.abort.signal
          : AbortSignal.any([requestSignal, session.abort.signal]),
    }
    return this.fetcher(input, options)
  }

  public webSocketConstructor(): AlphaWebSocketConstructor & {
    new (
      url: string,
    ): Pick<globalThis.WebSocket, 'readyState' | 'close' | 'addEventListener' | 'removeEventListener'>
  } {
    const sessions = this.sessions
    const isDisposed = (): boolean => this.disposed
    return class AuthorizedWebSocket extends WebSocket {
      public constructor(value: string, options?: { readonly headers?: Readonly<Record<string, string>> }) {
        const url = new URL(value)
        if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw invalidEndpoint()
        const httpUrl = new URL(url)
        httpUrl.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
        const endpoint = parseServerOrigin(httpUrl.origin)
        if (isDisposed() || endpoint === undefined || url.username !== '' || url.password !== '')
          throw invalidEndpoint()
        const session = sessions.get(endpoint.baseUrl)
        if (session === undefined && (endpoint.host !== '127.0.0.1' || url.protocol !== 'ws:'))
          throw invalidEndpoint()
        super(value, {
          ...options,
          ...(session === undefined ? {} : { lookup: session.lookup }),
          followRedirects: false,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          handshakeTimeout: 30_000,
        })
        if (session !== undefined) {
          session.sockets.add(this)
          this.once('close', () => session.sockets.delete(this))
        }
      }
    }
  }

  public async release(endpoint?: BackendEndpoint): Promise<void> {
    const entries =
      endpoint === undefined
        ? [...this.sessions.entries()]
        : [...this.sessions.entries()].filter(([key]) => key === endpoint.baseUrl)
    for (const [key, session] of entries) {
      this.sessions.delete(key)
      session.abort.abort()
      for (const socket of session.sockets) socket.terminate()
      await session.agent.destroy()
    }
  }

  public async dispose(): Promise<void> {
    this.disposed = true
    await this.release()
  }
}

function invalidEndpoint(): AppError {
  return new AppError({
    code: 'INVALID_ENDPOINT',
    message: 'The DSH endpoint is not authorized or resolves to a prohibited address.',
    retryable: false,
  })
}

async function resolveAddresses(hostname: string): Promise<readonly ResolvedEndpointAddress[]> {
  const results = await lookup(hostname, { all: true, verbatim: true })
  return results.flatMap((entry) =>
    entry.family === 4 || entry.family === 6 ? [{ address: entry.address, family: entry.family }] : [],
  )
}

function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1'
}

/** LAN addresses are intentional targets; metadata, loopback, link-local and non-unicast addresses are not. */
export function isDisallowedRemoteAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const bytes = address.split('.').map(Number)
    return (
      bytes[0] === 0 ||
      bytes[0] === 127 ||
      bytes[0]! >= 224 ||
      (bytes[0] === 169 && bytes[1] === 254) ||
      (bytes[0] === 192 && bytes[1] === 0 && bytes[2] === 0) ||
      address === '100.100.100.200'
    )
  }
  if (isIP(address) !== 6) return true
  const normalized = new URL(`http://[${address}]`).hostname.slice(1, -1)
  const halves = normalized.split('::')
  const left = halves[0] === '' ? [] : halves[0]!.split(':')
  const right = halves.length === 1 || halves[1] === '' ? [] : halves[1]!.split(':')
  const parts = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right].map((part) =>
    Number.parseInt(part, 16),
  )
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) {
    return isDisallowedRemoteAddress(
      `${parts[6]! >> 8}.${parts[6]! & 255}.${parts[7]! >> 8}.${parts[7]! & 255}`,
    )
  }
  return (
    normalized === 'fd00:ec2::254' ||
    parts.every((part) => part === 0) ||
    (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) ||
    (parts[0]! & 0xffc0) === 0xfe80 ||
    (parts[0]! & 0xff00) === 0xff00 ||
    parts.slice(0, 6).every((part) => part === 0)
  )
}

export function waitForSignal<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort)
      reject(new DOMException('The endpoint preparation was cancelled.', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void Promise.resolve(operation)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}
