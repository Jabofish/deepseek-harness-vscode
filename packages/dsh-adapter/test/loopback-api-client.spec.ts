import { describe, expect, it, vi } from 'vitest'

import { LoopbackApiClient } from '../src/loopback-api-client.js'

class FakeWebSocket {
  public static readonly instances: FakeWebSocket[] = []
  public readonly url: string
  public readyState = 0
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  public constructor(url: string) {
    this.url = url
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

function createClient(): LoopbackApiClient {
  return new LoopbackApiClient({
    endpoint: { host: '127.0.0.1', port: 4567, baseUrl: 'http://127.0.0.1:4567' },
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch: vi.fn(),
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
