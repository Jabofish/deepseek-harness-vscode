import { describe, expect, it, vi } from 'vitest'
import { Rc6SessionRepository } from '../src/repositories/session-repository.js'
import { AlphaLoopbackApiClient, type AlphaWebSocket } from '../src/versions/alpha/transport.js'
import type { BackendEndpoint } from '@dsh-vscode/domain'
import { validAlpha171SessionEvent } from '../src/versions/alpha171/session-wire.js'
import { rc6Mapper } from '../src/versions/rc6/mapper.js'

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

const toolResult = {
  type: 'tool/result',
  seq: 4,
  time: 5,
  surfaceOp: 'append',
  data: {
    turn: 1,
    step: 1,
    message: {
      id: 'tool-result-1',
      role: 'tool',
      source: { kind: 'tool', callId: 'call-1' },
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'completed' }],
    },
  },
} satisfies Record<string, unknown>

function recordEvent(event: Record<string, unknown>): Record<string, unknown> {
  return { type: 'event', event }
}

function snapshot(records: readonly Record<string, unknown>[], cursor: number): Record<string, unknown> {
  return {
    type: 'snapshot',
    header: { version: 4, id: 's1', createdAt: 1, isSeeded: false, delegationDepth: 0 },
    cursor,
    records,
    hasMore: true,
    projections: { asOfSeq: cursor, values: {} },
    assistantStream: { revision: 0 },
  }
}

function openFrames(socket: FakeWebSocket): { readonly endpoint: string; readonly streamId: string }[] {
  return socket.sent.flatMap((sent) => {
    const frame = JSON.parse(sent) as Record<string, unknown>
    return frame.type === 'open' && typeof frame.endpoint === 'string' && typeof frame.streamId === 'string'
      ? [{ endpoint: frame.endpoint, streamId: frame.streamId }]
      : []
  })
}

async function waitForOpen(
  socket: FakeWebSocket,
  endpointName: string,
  occurrence: number,
): Promise<{ readonly endpoint: string; readonly streamId: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const matching = openFrames(socket).filter((frame) => frame.endpoint === endpointName)
    const frame = matching[occurrence]
    if (frame !== undefined) return frame
    await Promise.resolve()
  }
  throw new Error(`the alpha mux did not open ${endpointName} occurrence ${occurrence + 1}`)
}

function sendItem(socket: FakeWebSocket, streamId: string, value: unknown): void {
  socket.message({ type: 'item', streamId, value })
}

function rpcResponse(rpcId: string, value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }), {
    headers: { 'content-type': 'application/json' },
  })
}

describe('alpha171 V4 history replay', () => {
  it('maps one native tool/result consistently from live events, the opening history, and a page', async () => {
    FakeWebSocket.instances.length = 0
    expect(validAlpha171SessionEvent(toolResult)).toBe(true)

    let pageRequest: Record<string, unknown> | undefined
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('the page request body is missing')
      const body = JSON.parse(init.body) as Record<string, unknown>
      pageRequest = body
      if (typeof body.rpcId !== 'string') throw new Error('the page request id is missing')
      return Promise.resolve(
        rpcResponse(body.rpcId, {
          records: [recordEvent(toolResult)],
          hasMore: false,
        }),
      )
    })
    const transport = new AlphaLoopbackApiClient({
      endpoint,
      requestTimeoutMs: 1_000,
      retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch,
      authCookie: () => 'dsh_session=test-cookie',
      webSocket: FakeWebSocket,
      sessionWireVersion: 'v4',
    })
    const sessions = new Rc6SessionRepository(transport)
    const liveController = new AbortController()
    const liveIterator = transport.openSessionStream('s1', liveController.signal)[Symbol.asyncIterator]()

    try {
      const liveBaselinePromise = liveIterator.next()
      const socket = await waitForSocket()
      socket.open()
      const liveOpening = await waitForOpen(socket, 'session/follow', 0)
      sendItem(socket, liveOpening.streamId, snapshot([], 3))
      await expect(liveBaselinePromise).resolves.toMatchObject({
        done: false,
        value: { type: 'session/subscribed', sessionId: 's1', lastSeq: 3 },
      })

      const liveEventPromise = liveIterator.next()
      sendItem(socket, liveOpening.streamId, { type: 'event', event: toolResult })
      const liveFrame = (await liveEventPromise).value as Record<string, unknown>
      expect(liveFrame.type).toBe('session/event')
      const liveEvent = liveFrame.event as Record<string, unknown>
      const liveMapped = { ...rc6Mapper.event('tool/result', liveEvent), sequence: toolResult.seq }
      expect(liveMapped.type).not.toBe('unknown')

      const openingHistoryPromise = sessions.history('s1')
      const openingHistoryStream = await waitForOpen(socket, 'session/follow', 1)
      sendItem(socket, openingHistoryStream.streamId, snapshot([recordEvent(toolResult)], 4))
      const openingHistory = await openingHistoryPromise
      expect(openingHistory.hasMore).toBe(true)
      expect(openingHistory.events[0]?.event).toEqual(liveMapped)

      const pageHistoryPromise = sessions.history('s1', 5)
      const pageHistoryStream = await waitForOpen(socket, 'session/follow', 2)
      sendItem(socket, pageHistoryStream.streamId, snapshot([], 4))
      const pageHistory = await pageHistoryPromise
      expect(pageHistory.hasMore).toBe(false)
      expect(pageHistory.events[0]?.sequence).toBe(4)
      expect(pageHistory.events[0]?.event).toEqual(liveMapped)

      const requestPayload = pageRequest?.payload as { readonly args?: unknown } | undefined
      expect(pageRequest?.method).toBe('session/page')
      expect(requestPayload?.args).toEqual({
        request: {
          address: { kind: 'session', sessionId: 's1' },
          throughSeq: 4,
          beforeSeq: 5,
          maxMessages: 50,
        },
      })
    } finally {
      liveController.abort()
      await liveIterator.return?.()
      await transport.close()
    }
  })
})

async function waitForSocket(): Promise<FakeWebSocket> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const socket = FakeWebSocket.instances[0]
    if (socket !== undefined) return socket
    await Promise.resolve()
  }
  throw new Error('the alpha mux socket was not created')
}
