import { describe, expect, it, vi } from 'vitest'

import { LoopbackApiClient } from '../src/loopback-api-client.js'

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

function createClient(fetch: typeof globalThis.fetch = vi.fn()): LoopbackApiClient {
  return new LoopbackApiClient({
    endpoint: { host: '127.0.0.1', port: 4567, baseUrl: 'http://127.0.0.1:4567' },
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
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
