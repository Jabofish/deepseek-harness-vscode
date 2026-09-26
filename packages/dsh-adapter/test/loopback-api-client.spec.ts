import { describe, expect, it, vi } from 'vitest'

import { LoopbackApiClient } from '../src/loopback-api-client.js'
import { Rc6CredentialRepository } from '../src/repositories/credential-repository.js'

class FakeWebSocket {
  public static readonly instances: FakeWebSocket[] = []
  public static openOnConstruct = false
  public readonly url: string
  public readyState = 0
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  public constructor(url: string) {
    this.url = url
    if (FakeWebSocket.openOnConstruct) this.readyState = 1
    FakeWebSocket.instances.push(this)
  }

  public addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: unknown) => void>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  public removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  public close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', new Event('close'))
  }

  public open(): void {
    this.readyState = 1
    this.emit('open', new Event('open'))
  }

  public message(data: unknown): void {
    this.emit('message', { data })
  }

  public error(): void {
    this.emit('error', new Event('error'))
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function createClient(
  fetch: typeof globalThis.fetch = vi.fn(),
  requestTimeoutMs = 1_000,
  maximumAttempts = 1,
  retryDelayMs = 1,
): LoopbackApiClient {
  return new LoopbackApiClient({
    endpoint: { host: '127.0.0.1', port: 4567, baseUrl: 'http://127.0.0.1:4567' },
    requestTimeoutMs,
    retryPolicy: { maximumAttempts, baseDelayMs: retryDelayMs, maximumDelayMs: retryDelayMs },
    fetch,
    webSocket: FakeWebSocket as unknown as typeof globalThis.WebSocket,
  })
}

function serverFrame(payload: unknown): string {
  return JSON.stringify({
    type: 'server-request',
    rpcId: 'rpc-1',
    method: typeof payload === 'object' && payload !== null && 'type' in payload ? payload.type : 'unknown',
    payload,
  })
}

describe('LoopbackApiClient rc.6 event transport', () => {
  it('keeps RC6 Host credential missing-state and empty-write receipts compatible', async () => {
    const paths: string[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(await new Response(init?.body ?? null).text()) as { readonly rpcId: string }
      const url =
        typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url)
      paths.push(url.pathname)
      const path = paths.at(-1)
      const value =
        path === '/api/credentials.describe'
          ? { credentials: { API_KEY: { configured: false, writable: true } } }
          : {}
      return new Response(
        JSON.stringify({
          type: 'server-response',
          rpcId: request.rpcId,
          result: { ok: true, value },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    })
    const client = createClient(fetch)
    const credentials = new Rc6CredentialRepository(client)

    try {
      await expect(credentials.describeReference('API_KEY')).resolves.toEqual({
        ref: 'API_KEY',
        configured: false,
        writable: true,
      })
      await expect(credentials.setReference('API_KEY', 'host-only-secret')).resolves.toBeUndefined()
      await expect(credentials.unsetReference('API_KEY')).resolves.toBeUndefined()
      expect(paths).toEqual(['/api/credentials.describe', '/api/credentials.set', '/api/credentials.unset'])
    } finally {
      await client.close()
    }
  })

  it('rejects an omitted requested credential row through the RC6 Host carrier', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(await new Response(init?.body ?? null).text()) as { readonly rpcId: string }
      return new Response(
        JSON.stringify({
          type: 'server-response',
          rpcId: request.rpcId,
          result: { ok: true, value: { credentials: {} } },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    })
    const client = createClient(fetch)
    const credentials = new Rc6CredentialRepository(client)

    try {
      await expect(credentials.describeReference('API_KEY')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    } finally {
      await client.close()
    }
  })

  it('maps transient HTTP failures with method/status diagnostics and retries them', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response('', { status: 503 })))
    const client = createClient(fetch, 1_000, 3)

    await expect(client.request('session.list', {})).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
      retryable: true,
      context: { method: 'session.list', status: 503 },
    })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('does not retry a permanent HTTP or protocol failure', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response('', { status: 400 })))
    const client = createClient(fetch, 1_000, 3)

    await expect(client.request('session.list', {})).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      retryable: false,
      context: { method: 'session.list', status: 400 },
    })
    expect(fetch).toHaveBeenCalledTimes(1)

    const malformedFetch = vi.fn(() =>
      Promise.resolve(new Response('{malformed', { headers: { 'content-type': 'application/json' } })),
    )
    await expect(createClient(malformedFetch, 1_000, 3).request('session.list', {})).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      retryable: false,
    })
    expect(malformedFetch).toHaveBeenCalledTimes(1)
  })

  it('retries RC2 Schedule read Remotes but never replays update or delete', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response('', { status: 503 })))
    const client = createClient(fetch, 1_000, 3)

    for (const [index, endpoint] of ['schedule/catalog', 'schedule/list', 'schedule/history'].entries()) {
      await expect(client.remoteRequest(endpoint, {})).rejects.toMatchObject({
        code: 'BACKEND_UNREACHABLE',
        retryable: true,
        context: { method: endpoint, status: 503 },
      })
      expect(fetch).toHaveBeenCalledTimes((index + 1) * 3)
    }

    await expect(client.remoteRequest('schedule/update', {})).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
      retryable: true,
      context: { method: 'schedule/update', status: 503 },
    })
    expect(fetch).toHaveBeenCalledTimes(10)

    await expect(client.remoteRequest('schedule/delete', {})).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
      retryable: true,
      context: { method: 'schedule/delete', status: 503 },
    })
    expect(fetch).toHaveBeenCalledTimes(11)
  })

  it('releases the unread body of every failed RPC response so the loopback connection returns to the pool', async () => {
    // An unconsumed fetch body pins its socket until GC; a cancel callback is
    // the observable the transport has for "the connection was released".
    let cancelCalls = 0
    const fetch = vi.fn(() => {
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelCalls += 1
        },
      })
      return Promise.resolve(new Response(body, { status: 503 }))
    })
    const client = createClient(fetch, 1_000, 3)

    await expect(client.request('session.list', {})).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
      retryable: true,
      context: { method: 'session.list', status: 503 },
    })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(cancelCalls).toBe(3)
  })

  it('releases the unread body of a failed session log download', async () => {
    let cancelCalls = 0
    const fetch = vi.fn(() => {
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelCalls += 1
        },
      })
      return Promise.resolve(new Response(body, { status: 404 }))
    })

    await expect(createClient(fetch).downloadSessionLog('session-1', false)).rejects.toMatchObject({
      code: 'EXPORT_FAILED',
      retryable: false,
      context: { method: 'session.export', status: 404 },
    })
    expect(cancelCalls).toBe(1)
  })

  it('distinguishes timeout, cancellation, and network failures', async () => {
    const timeout = vi.fn(() => Promise.reject(new DOMException('request timed out', 'TimeoutError')))
    await expect(createClient(timeout).request('session.history', {})).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
      retryable: true,
      context: { method: 'session.history', timedOut: true },
    })

    const cancellation = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        })
      })
      return new Response()
    })
    const client = createClient(cancellation)
    const controller = new AbortController()
    const pending = client.request('session.history', {}, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED', retryable: false })
    expect(cancellation).toHaveBeenCalledTimes(1)

    const network = vi.fn(() => Promise.reject(new TypeError('fetch failed')))
    await expect(createClient(network).request('session.list', {})).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
      retryable: true,
      context: { method: 'session.list' },
    })
  })

  it('stops an idempotent retry backoff when the transport closes', async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError('fetch failed')))
    const client = createClient(fetch, 1_000, 2, 60_000)
    const caller = new AbortController()
    const pending = client.request('session.list', {}, caller.signal)
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
      await client.close()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      expect(settled).toBe(true)
      await expect(pending).rejects.toMatchObject({ code: 'BACKEND_UNREACHABLE', retryable: false })
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      caller.abort()
      await client.close()
      await pending.catch(() => undefined)
    }
  })

  it('accepts mixed-case Typert namespaces used by optional DSH remotes', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(await new Response(init?.body ?? null).text()) as { readonly rpcId: string }
      return new Response(
        JSON.stringify({
          type: 'server-response',
          rpcId: request.rpcId,
          result: { ok: true, value: { ok: true, value: { items: [] } } },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    })
    const client = createClient(fetch)

    await expect(
      client.remoteRequest('messageFeedback/list', { request: { sessionId: 's1' } }),
    ).resolves.toEqual({
      ok: true,
      value: { ok: true, value: { items: [] } },
    })
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/api/messageFeedback/list' }),
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('times out a hung Remote call without waiting for a caller signal', async () => {
    const hung = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              reject(
                init.signal?.reason instanceof Error
                  ? init.signal.reason
                  : new DOMException('aborted', 'AbortError'),
              )
            },
            { once: true },
          )
        }),
    )
    const client = createClient(hung, 20)

    await expect(client.remoteRequest('pluginInventory/list', { agentId: 's1' })).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
      retryable: true,
      context: { method: 'pluginInventory/list', timedOut: true },
    })
    expect(hung).toHaveBeenCalledTimes(1)
  })

  it('accepts a socket that reached OPEN before listeners were attached', async () => {
    FakeWebSocket.instances.length = 0
    FakeWebSocket.openOnConstruct = true
    const client = createClient()
    const iterator = client.openMuxStream(new AbortController().signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    const socket = FakeWebSocket.instances[0]
    socket?.message(serverFrame({ type: 'session/subscribed', sessionId: 's1', lastSeq: 0 }))
    await expect(next).resolves.toMatchObject({
      done: false,
      value: { payload: { type: 'session/subscribed' } },
    })
    await iterator.return?.()
    FakeWebSocket.openOnConstruct = false
  })

  it('normalizes the rc.6 settings-not-exposed error before the rc.8 envelope parser', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(await new Response(init?.body ?? null).text()) as { readonly rpcId: string }
      return new Response(
        JSON.stringify({
          type: 'server-response',
          rpcId: request.rpcId,
          result: {
            ok: false,
            error: {
              code: 'settings-not-exposed',
              message: 'namespace is not exposed',
              details: { ns: 'provider.test' },
            },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    })
    const client = createClient(fetch)

    await expect(client.request('settings.describe', {})).resolves.toMatchObject({
      result: { ok: false, error: { code: 'settings-rejected', details: { ns: 'provider.test' } } },
    })
  })

  it('does not clone successful non-settings RPC responses during legacy probing', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(await new Response(init?.body ?? null).text()) as { readonly rpcId: string }
      return new Response(
        JSON.stringify({
          type: 'server-response',
          rpcId: request.rpcId,
          result: { ok: true, value: { sessions: [] } },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    })
    const clone = vi.spyOn(Response.prototype, 'clone')
    try {
      await expect(createClient(fetch).request('session.list', {})).resolves.toMatchObject({
        result: { ok: true, value: { sessions: [] } },
      })
      expect(clone).not.toHaveBeenCalled()
    } finally {
      clone.mockRestore()
    }
  })

  it('does not apply the rc.8 value schema to an rc.7 session history projection', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(await new Response(init?.body ?? null).text()) as { readonly rpcId: string }
      return new Response(
        JSON.stringify({
          type: 'server-response',
          rpcId: request.rpcId,
          result: {
            ok: true,
            value: {
              events: [],
              hasMore: false,
              projections: {
                asOfSeq: -1,
                values: {
                  // rc.7 imageLimits predates rc.8's maxImageDimension field.
                  imageLimits: {
                    maxImageBytes: 1,
                    maxImagesPerMessage: 1,
                    maxMessageImageBytes: 1,
                    maxImagePixels: 1,
                    mediaTypes: [],
                  },
                },
              },
            },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    })
    const client = createClient(fetch)

    await expect(client.request('session.history', { sessionId: 's1' })).resolves.toMatchObject({
      result: {
        ok: true,
        value: { projections: { values: { imageLimits: { maxImagePixels: 1 } } } },
      },
    })
  })

  it('opens mux and host event paths as WebSocket downlinks instead of SSE fetches', async () => {
    FakeWebSocket.instances.length = 0
    const client = createClient()
    const muxIterator = client.openMuxStream(new AbortController().signal)[Symbol.asyncIterator]()
    const muxNext = muxIterator.next()
    const muxSocket = FakeWebSocket.instances[0]
    expect(muxSocket?.url).toBe('ws://127.0.0.1:4567/api/events.mux')
    muxSocket?.open()
    muxSocket?.message(serverFrame({ type: 'session/subscribed', sessionId: 's1', lastSeq: 0 }))
    await expect(muxNext).resolves.toMatchObject({
      done: false,
      value: { rpcId: 'rpc-1', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 0 } },
    })
    await muxIterator.return?.()

    const hostIterator = client.openHostStream(new AbortController().signal)[Symbol.asyncIterator]()
    const hostNext = hostIterator.next()
    const hostSocket = FakeWebSocket.instances[1]
    expect(hostSocket?.url).toBe('ws://127.0.0.1:4567/api/events.host')
    hostSocket?.open()
    hostSocket?.message(serverFrame({ type: 'host/session-status', sessionId: 's1', running: false }))
    await expect(hostNext).resolves.toMatchObject({
      done: false,
      value: { rpcId: 'rpc-1', payload: { type: 'host/session-status', sessionId: 's1', running: false } },
    })
    await hostIterator.return?.()
  })

  it('fails closed on malformed WebSocket frames', async () => {
    FakeWebSocket.instances.length = 0
    const client = createClient()
    const iterator = client.openMuxStream(new AbortController().signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    const socket = FakeWebSocket.instances[0]
    socket?.message('{malformed')
    await expect(next).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await iterator.return?.()
  })

  it('keeps a future frame type available for the adapter fallback', async () => {
    FakeWebSocket.instances.length = 0
    const client = createClient()
    const iterator = client.openMuxStream(new AbortController().signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    const socket = FakeWebSocket.instances[0]
    socket?.open()
    socket?.message(
      serverFrame({ type: 'future/frame', sessionId: 's1', token: 'must stay in the Host', safe: 'ok' }),
    )
    await expect(next).resolves.toMatchObject({
      done: false,
      value: {
        payload: { type: 'future/frame', sessionId: 's1', token: 'must stay in the Host', safe: 'ok' },
      },
    })
    await iterator.return?.()
  })

  it('surfaces a WebSocket failure and closes the socket on cancellation', async () => {
    FakeWebSocket.instances.length = 0
    const client = createClient()
    const abort = new AbortController()
    const iterator = client.openMuxStream(abort.signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    const socket = FakeWebSocket.instances[0]
    socket?.error()
    await expect(next).rejects.toThrow('The DSH event stream transport failed.')
    expect(socket?.readyState).toBe(3)

    FakeWebSocket.instances.length = 0
    const cancellation = new AbortController()
    const cancelledIterator = client.openHostStream(cancellation.signal)[Symbol.asyncIterator]()
    const cancelledNext = cancelledIterator.next()
    const cancelledSocket = FakeWebSocket.instances[0]
    cancellation.abort()
    await expect(cancelledNext).resolves.toEqual({ done: true, value: undefined })
    expect(cancelledSocket?.readyState).toBe(3)
  })
})
