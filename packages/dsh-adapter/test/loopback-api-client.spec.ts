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
    webSocket: FakeWebSocket,
  })
}

describe('LoopbackApiClient rc.6 event transport', () => {
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
})
