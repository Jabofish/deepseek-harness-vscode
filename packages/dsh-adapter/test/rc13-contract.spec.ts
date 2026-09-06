import { describe, expect, it, vi } from 'vitest'

import type { BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import { VersionedBackendProbe } from '../src/probe.js'
import type { AlphaLoopbackApiClient, AlphaWebSocket } from '../src/versions/alpha/transport.js'
import { Rc13VersionAdapter } from '../src/versions/rc13/adapter.js'

class FakeWebSocket implements AlphaWebSocket {
  public static readonly instances: FakeWebSocket[] = []
  public readyState = 0
  public readonly sent: string[] = []
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  public constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  public send(data: string): void {
    this.sent.push(data)
  }

  public close(): void {
    this.readyState = 3
    this.emit('close', {})
  }

  public addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: unknown) => void>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  public removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  public open(): void {
    this.readyState = 1
    this.emit('open', {})
  }

  public message(value: unknown): void {
    this.emit('message', { data: JSON.stringify(value) })
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const endpoint: BackendEndpoint = {
  host: '127.0.0.1',
  port: 4567,
  baseUrl: 'http://127.0.0.1:4567',
}

function candidate(runtimeVersion: string): BackendCandidate {
  return { endpoint, source: 'configured', runtimeVersion, confidence: 1 }
}

function response(init: RequestInit | undefined, value: unknown): Response {
  if (typeof init?.body !== 'string') throw new Error('test request body is not a string')
  const request = JSON.parse(init.body) as { readonly rpcId?: string }
  return new Response(
    JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }),
    { headers: { 'content-type': 'application/json' } },
  )
}

function streamItem(socket: FakeWebSocket, value: unknown): unknown {
  const opening = JSON.parse(socket.sent[0] ?? '{}') as { readonly streamId?: string }
  return { type: 'item', streamId: opening.streamId, value }
}

async function waitForSocket(): Promise<FakeWebSocket> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const socket = FakeWebSocket.instances[0]
    if (socket !== undefined) return socket
    await Promise.resolve()
  }
  throw new Error('the rc13 mux socket was not created')
}

async function waitForSent(socket: FakeWebSocket): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (socket.sent.length > 0) return
    await Promise.resolve()
  }
  throw new Error('the rc13 mux open frame was not sent')
}

describe('DSH 0.1.2-rc.1 Connection/Gateway contract', () => {
  it('selects the published release exactly without treating it as Session v2', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { items: [] })),
    )
    const adapter = new Rc13VersionAdapter({
      requestTimeoutMs: 1_000,
      retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch,
    })

    await expect(adapter.probe(candidate('0.1.2-rc.1'))).resolves.toMatchObject({
      protocolVersion: 'rc13',
      dshVersion: '0.1.2-rc.1',
    })
    await expect(adapter.probe(candidate('0.1.2-alpha.5'))).resolves.toBeUndefined()

    const future = await new VersionedBackendProbe([adapter]).probe(candidate('0.1.2-rc.2'))
    expect(future).toMatchObject({
      capabilities: {
        protocolVersion: 'rc13',
        dshVersion: '0.1.2-rc.2',
        compatibilityMode: 'best-effort',
      },
    })
  })

  it('keeps the v0 follow request and packed history path for the published rc.1 wire', async () => {
    FakeWebSocket.instances.length = 0
    const adapter = new Rc13VersionAdapter({
      requestTimeoutMs: 1_000,
      retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
      webSocket: FakeWebSocket,
    })
    const transport = adapter.createTransport(endpoint) as AlphaLoopbackApiClient
    const iterator = transport.openSessionStream('s1', new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket)

    const opening = JSON.parse(socket.sent[0] ?? '{}') as {
      readonly endpoint?: string
      readonly payload?: { readonly args?: { readonly request?: Record<string, unknown> } }
    }
    expect(opening).toMatchObject({
      endpoint: 'session/follow',
      payload: {
        args: {
          request: {
            address: { kind: 'session', sessionId: 's1' },
            maxMessages: 50,
          },
        },
      },
    })
    expect(opening.payload?.args?.request).not.toHaveProperty('assistantStream')

    socket.message(
      streamItem(socket, {
        type: 'snapshot',
        header: { version: 1, id: 's1', createdAt: 1, seedLength: 0 },
        cursor: 0,
        records: [],
        hasMore: false,
        projections: { asOfSeq: 0, values: {} },
      }),
    )
    await expect(first).resolves.toMatchObject({ value: { type: 'session/subscribed', lastSeq: 0 } })
    await iterator.return?.()
    await transport.close()
  })
})
