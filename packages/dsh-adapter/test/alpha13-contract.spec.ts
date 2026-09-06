import { describe, expect, it, vi } from 'vitest'

import type { BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import { VersionedBackendProbe } from '../src/probe.js'
import { AlphaLoopbackApiClient, type AlphaWebSocket } from '../src/versions/alpha/transport.js'
import { Alpha13AssistantStreamProjector } from '../src/versions/alpha13/session-wire.js'
import { Alpha13VersionAdapter } from '../src/versions/alpha13/adapter.js'

class FakeWebSocket implements AlphaWebSocket {
  public static readonly instances: FakeWebSocket[] = []
  public readyState = 0
  public readonly sent: string[] = []
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

function transport(fetch: typeof globalThis.fetch): AlphaLoopbackApiClient {
  return new AlphaLoopbackApiClient({
    endpoint,
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch,
    authCookie: () => 'dsh_session=test-cookie',
    webSocket: FakeWebSocket,
    sessionWireVersion: 'v2',
  })
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
  throw new Error('the alpha13 mux socket was not created')
}

async function waitForSent(socket: FakeWebSocket, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (socket.sent.length >= count) return
    await Promise.resolve()
  }
  throw new Error(`expected ${String(count)} mux frame(s)`)
}

function snapshot(): Record<string, unknown> {
  return {
    type: 'snapshot',
    header: { version: 1, id: 's1', createdAt: 1, isSeeded: false },
    cursor: 0,
    records: [],
    hasMore: false,
    projections: { asOfSeq: 0, values: {} },
    assistantStream: { revision: 0 },
  }
}

describe('DSH 0.1.3-alpha.1 Session v2 contract', () => {
  it('selects the exact latest source snapshot and makes it the newest compatibility fallback', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { items: [] })),
    )
    const adapter = new Alpha13VersionAdapter({
      requestTimeoutMs: 1_000,
      retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch,
    })

    await expect(adapter.probe(candidate('0.1.3-alpha.1'))).resolves.toMatchObject({
      protocolVersion: 'alpha13',
      dshVersion: '0.1.3-alpha.1',
      subagentImagePrompts: true,
    })

    const connected = await new VersionedBackendProbe([
      new Alpha13VersionAdapter({
        requestTimeoutMs: 1_000,
        retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
        fetch,
      }),
    ]).probe(candidate('0.1.3-alpha.2'))

    expect(connected).toMatchObject({
      capabilities: {
        protocolVersion: 'alpha13',
        dshVersion: '0.1.3-alpha.2',
        adapterId: 'dsh-0.1.3-alpha.1',
        compatibilityMode: 'best-effort',
        subagentImagePrompts: false,
      },
    })
  })

  it('requests assistantStream and folds start, durable settlement, chunk, and end in wire order', async () => {
    FakeWebSocket.instances.length = 0
    const client = transport(
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
    )
    const iterator = client.openSessionStream('s1', new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)

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
            assistantStream: true,
          },
        },
      },
    })

    socket.message(streamItem(socket, snapshot()))
    await expect(first).resolves.toMatchObject({ value: { type: 'session/subscribed', lastSeq: 0 } })

    const chunkNext = iterator.next()
    socket.message(
      streamItem(socket, {
        type: 'assistant-stream',
        frame: {
          type: 'start',
          attemptId: 'attempt-1',
          revision: 1,
          startedAfterSeq: 0,
          turn: 1,
          step: 1,
        },
      }),
    )
    socket.message(
      streamItem(socket, {
        type: 'event',
        event: {
          type: 'assistant/message',
          seq: 1,
          time: 101,
          surfaceOp: 'append',
          data: { turn: 1, step: 1, message: {} },
        },
      }),
    )
    socket.message(
      streamItem(socket, {
        type: 'assistant-stream',
        frame: {
          type: 'chunk',
          attemptId: 'attempt-1',
          revision: 2,
          index: 0,
          time: 102,
          chunk: { type: 'text-delta', index: 0, text: 'hello' },
        },
      }),
    )
    await expect(chunkNext).resolves.toMatchObject({
      value: {
        type: 'session/assistant-stream',
        sessionId: 's1',
        transientSequence: 1,
        frame: { type: 'chunk', attemptId: 'attempt-1', revision: 2, index: 0, turn: 1, step: 1 },
      },
    })

    const settlementNext = iterator.next()
    socket.message(
      streamItem(socket, {
        type: 'assistant-stream',
        frame: {
          type: 'end',
          attemptId: 'attempt-1',
          revision: 3,
          index: 1,
          outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 },
        },
      }),
    )
    await expect(settlementNext).resolves.toMatchObject({
      value: { type: 'session/event', sessionId: 's1', event: { type: 'assistant/message', seq: 1 } },
    })

    await iterator.return?.()
    await client.close()
  })

  it('reconstructs compact reconnect chunks and rejects malformed continuity', () => {
    const projector = new Alpha13AssistantStreamProjector()
    const baseline = projector.open(
      {
        revision: 1,
        activeAttempt: {
          attemptId: 'attempt-1',
          startedAfterSeq: 0,
          turn: 1,
          step: 1,
          nextIndex: 2,
          stream: [{ type: 'text-chunks', time0: 100, index: 0, dt: [2], texts: ['a', 'b'] }],
        },
      },
      's1',
    )
    expect(baseline.map((output) => output.type === 'chunk' && output.chunk)).toEqual([
      { type: 'text-delta', index: 0, text: 'a' },
      { type: 'text-delta', index: 0, text: 'b' },
    ])

    const durable = {
      type: 'assistant/message',
      seq: 7,
      time: 103,
      surfaceOp: 'append',
      data: { turn: 1, step: 1, message: {} },
      sessionId: 's1',
    }
    expect(projector.acceptDurable(durable)).toEqual([])
    expect(() =>
      projector.acceptFrame(
        {
          type: 'chunk',
          attemptId: 'attempt-1',
          revision: 4,
          index: 2,
          time: 104,
          chunk: { type: 'text-delta', index: 0, text: 'c' },
        },
        's1',
      ),
    ).toThrow(/skipped revision/u)

    expect(() =>
      new Alpha13AssistantStreamProjector().open(
        {
          revision: 1,
          activeAttempt: {
            attemptId: 'attempt-1',
            startedAfterSeq: 0,
            turn: 1,
            step: 1,
            nextIndex: 2,
            stream: [{ type: 'text-chunks', time0: 100, index: 0, dt: [], texts: ['a', 'b'] }],
          },
        },
        's1',
      ),
    ).toThrow(/gaps/u)
  })

  it('reconstructs lossless raw records emitted by the compact stream accumulator', () => {
    const [output] = new Alpha13AssistantStreamProjector().open(
      {
        revision: 1,
        activeAttempt: {
          attemptId: 'attempt-raw',
          startedAfterSeq: -1,
          turn: 1,
          step: 1,
          nextIndex: 1,
          stream: [{ type: 'chunk', time: 42, chunk: { type: 'text-delta', index: 0, text: 'raw' } }],
        },
      },
      's1',
    )

    expect(output).toMatchObject({
      type: 'chunk',
      attemptId: 'attempt-raw',
      index: 0,
      time: 42,
      chunk: { type: 'text-delta', index: 0, text: 'raw' },
    })
  })
})
