import { describe, expect, it, vi } from 'vitest'

import type { BackendEndpoint } from '@dsh-vscode/domain'

import { Alpha162VersionAdapter } from '../src/versions/alpha162/adapter.js'
import type { AlphaLoopbackApiClient, AlphaWebSocket } from '../src/versions/alpha/transport.js'
import { callRpc } from '../src/versions/rc6/rpc.js'

/**
 * Fixture authority: DSH tag `dsh-v0.1.6-alpha.2`, commit
 * `ddefc45fbc7f8e46dd73185e68295696d1297887`; the `SessionControlFrame` and
 * `SessionControlBaseline` declarations are in
 * `packages/api/session-controller/src/types.ts`, and `InboxWireState` is in
 * `packages/core/agent/src/types.ts`.
 */
class FakeWebSocket implements AlphaWebSocket {
  public static readonly instances: FakeWebSocket[] = []
  public readyState = 0
  public readonly sent: string[] = []
  public closeCalls = 0
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  public constructor(
    public readonly url: string,
    public readonly options?: unknown,
  ) {
    FakeWebSocket.instances.push(this)
  }

  public send(data: string): void {
    this.sent.push(data)
  }

  public close(): void {
    this.closeCalls += 1
    this.readyState = 3
    this.emit('close', {})
  }

  public addEventListener(type: string, listener: (event: unknown) => void): void {
    const entries = this.listeners.get(type) ?? new Set<(event: unknown) => void>()
    entries.add(listener)
    this.listeners.set(type, entries)
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

const adapterOptions = {
  requestTimeoutMs: 1_000,
  retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
  fetch: globalThis.fetch,
  webSocket: FakeWebSocket,
}

function adapter(): Alpha162VersionAdapter {
  return new Alpha162VersionAdapter(adapterOptions)
}

function streamItem(socket: FakeWebSocket, value: unknown): unknown {
  const opening = JSON.parse(socket.sent[0] ?? '{}') as { readonly streamId?: unknown }
  return { type: 'item', streamId: opening.streamId, value }
}

async function waitForSocket(): Promise<FakeWebSocket> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const socket = FakeWebSocket.instances[0]
    if (socket !== undefined) return socket
    await Promise.resolve()
  }
  throw new Error('the alpha mux socket was not created')
}

async function waitForSent(socket: FakeWebSocket, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (socket.sent.length >= count) return
    await Promise.resolve()
  }
  throw new Error(`the alpha mux socket sent ${socket.sent.length} frames; expected ${count}`)
}

function inboxMessage(id: string, text: string, source: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }
}

describe('DSH 0.1.6-alpha.2 Session-Control contract', () => {
  it('uses the exact identity and projects the Inbox baseline and incremental updates', async () => {
    expect(adapter()).toMatchObject({
      id: 'dsh-0.1.6-alpha.2',
      supportedVersion: '0.1.6-alpha.2',
      protocolVersion: 'alpha162',
      fallback: false,
    })

    FakeWebSocket.instances.length = 0
    const transport = adapter().createTransport(endpoint) as AlphaLoopbackApiClient
    const iterator = transport.openHostStream(new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(
      streamItem(socket, {
        type: 'baseline',
        value: {
          jobs: { 's-1': [] },
          projections: {
            's-1': {
              asOfSeq: 12,
              values: {
                inbox: {
                  'next-turn': [inboxMessage('m-queue', 'queued text', { kind: 'user', rpcId: 'req-1' })],
                  'next-step': [inboxMessage('m-steer', 'steering text', { kind: 'plugin', plugin: 'test' })],
                },
              },
            },
          },
        },
      }),
    )

    await expect(first).resolves.toMatchObject({
      value: { type: 'session/jobs', sessionId: 's-1', jobs: [] },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'session/queue',
        sessionId: 's-1',
        items: [
          { id: 'm-queue', placement: 'queued', rpcId: 'req-1', message: { id: 'm-queue' } },
          { id: 'm-steer', placement: 'steering', message: { id: 'm-steer' } },
        ],
      },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'session/projection', sessionId: 's-1', key: 'inbox', seq: 12 },
    })

    socket.message(
      streamItem(socket, {
        type: 'projection',
        sessionId: 's-1',
        key: 'inbox',
        seq: 13,
        value: { 'next-turn': [], 'next-step': [inboxMessage('m-next', 'next step', { kind: 'user' })] },
      }),
    )
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'session/queue', items: [{ id: 'm-next', placement: 'steering' }] },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'session/projection', sessionId: 's-1', key: 'inbox', seq: 13 },
    })

    await transport.close()
  })

  it('rejects the alpha.1 queues baseline and malformed Inbox values fail closed', async () => {
    FakeWebSocket.instances.length = 0
    const transport = adapter().createTransport(endpoint) as AlphaLoopbackApiClient
    const iterator = transport.openHostStream(new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(
      streamItem(socket, {
        type: 'baseline',
        value: { queues: {}, jobs: {}, projections: {} },
      }),
    )
    await expect(first).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await transport.close()

    FakeWebSocket.instances.length = 0
    const malformedTransport = adapter().createTransport(endpoint) as AlphaLoopbackApiClient
    const malformedStream = malformedTransport.openHostStream(new AbortController().signal)
    const malformedIterator = malformedStream[Symbol.asyncIterator]()
    const malformedFirst = malformedIterator.next()
    const malformedSocket = await waitForSocket()
    malformedSocket.open()
    await waitForSent(malformedSocket, 1)
    malformedSocket.message(
      streamItem(malformedSocket, {
        type: 'projection',
        sessionId: 's-1',
        key: 'inbox',
        seq: 1,
        value: {
          'next-turn': [inboxMessage('duplicate', 'one', { kind: 'user' })],
          'next-step': [inboxMessage('duplicate', 'two', { kind: 'user' })],
        },
      }),
    )
    await expect(malformedFirst).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await malformedTransport.close()
  })

  it('normalizes writer-held as a retryable backend-busy error', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(bodyText(init)) as { readonly rpcId: string }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'server-response',
            rpcId: body.rpcId,
            result: {
              ok: false,
              error: { code: 'session/writer-held', message: 'writer held', details: { sessionId: 's-1' } },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )
    })
    const transport = new Alpha162VersionAdapter({ ...adapterOptions, fetch }).createTransport(endpoint)

    await expect(callRpc(transport, 'session.list', {})).rejects.toMatchObject({
      code: 'BACKEND_BUSY',
      retryable: true,
      context: { rpcCode: 'writer-held' },
    })
    await transport.close()
  })

  it('cancels the logical control stream and closes the physical mux', async () => {
    FakeWebSocket.instances.length = 0
    const transport = adapter().createTransport(endpoint) as AlphaLoopbackApiClient
    const cancellation = new AbortController()
    const iterator = transport.openHostStream(cancellation.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)

    cancellation.abort()
    await expect(pending).resolves.toMatchObject({ done: true })
    await waitForSent(socket, 2)
    expect(JSON.parse(socket.sent[1] ?? '{}')).toMatchObject({ type: 'cancel' })

    await transport.close()
    expect(socket.closeCalls).toBe(1)
  })
})

function bodyText(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('test request body is not a string')
  return init.body
}
