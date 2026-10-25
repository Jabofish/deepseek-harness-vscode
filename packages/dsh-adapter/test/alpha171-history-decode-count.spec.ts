import { describe, expect, it, vi } from 'vitest'
import type { BackendEndpoint } from '@dsh-vscode/domain'
import { AlphaLoopbackApiClient, type AlphaWebSocket } from '../src/versions/alpha/transport.js'
import type { AlphaV4SessionProfile } from '../src/versions/alpha171/session-wire.js'
import { Rc6SessionRepository } from '../src/repositories/session-repository.js'

/**
 * The v4 history RPC reads its follow snapshot and then expands history
 * records. Both passes used to run the per-record V4 codec on every row:
 * twice for an opening history call, and a full tail decode just to learn the
 * cursor before a page request. Each durable row must now be admitted by the
 * codec exactly once per RPC.
 */

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
    for (const listener of this.listeners.get(type) ?? new Set()) listener(event)
  }
}

const endpoint: BackendEndpoint = {
  host: '127.0.0.1',
  port: 4567,
  baseUrl: 'http://127.0.0.1:4567',
}

function toolResultEvent(sequence: number): Record<string, unknown> {
  return {
    type: 'tool/result',
    seq: sequence,
    time: sequence,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `tool-result-${sequence}`,
        role: 'tool',
        source: { kind: 'tool', callId: `call-${sequence}` },
        toolCallId: `call-${sequence}`,
        content: [{ type: 'text', text: 'completed' }],
      },
    },
  }
}

function snapshotFrame(records: readonly Record<string, unknown>[], cursor: number): Record<string, unknown> {
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
  endpointName: string,
  occurrence: number,
): Promise<{ socket: FakeWebSocket; streamId: string }> {
  const socket = await vi.waitFor(() => {
    const instance = FakeWebSocket.instances[0]
    if (instance === undefined) throw new Error('The mux socket has not been created.')
    return instance
  })
  if (socket.readyState !== 1) socket.open()
  return vi.waitFor(() => {
    const frame = openFrames(socket).filter((open) => open.endpoint === endpointName)[occurrence]
    if (frame === undefined)
      throw new Error(`the alpha mux did not open ${endpointName} occurrence ${occurrence + 1}`)
    return { socket, streamId: frame.streamId }
  })
}

function countingProfile(counter: { validateEventCalls: number }): AlphaV4SessionProfile {
  return {
    eventValidators: {},
    validateEvent: () => {
      counter.validateEventCalls += 1
    },
  }
}

function rpcResponse(rpcId: string, value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }), {
    headers: { 'content-type': 'application/json' },
  })
}

describe('alpha171 V4 history decode counts', () => {
  it('admits each opening-history record through the V4 codec exactly once', async () => {
    FakeWebSocket.instances.length = 0
    const counter = { validateEventCalls: 0 }
    const records = 300
    const transport = new AlphaLoopbackApiClient({
      endpoint,
      requestTimeoutMs: 1_000,
      retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch: () => Promise.reject(new Error('no RPC expected for the opening history call')),
      authCookie: () => 'dsh_session=test-cookie',
      webSocket: FakeWebSocket,
      sessionWireVersion: 'v4',
      sessionWireProfile: countingProfile(counter),
    })
    const sessions = new Rc6SessionRepository(transport)
    const historyPromise = sessions.history('s1')
    const opening = await waitForOpen('session/follow', 0)
    opening.socket.message({
      type: 'item',
      streamId: opening.streamId,
      value: snapshotFrame(
        Array.from({ length: records }, (_, index) => ({ type: 'event', event: toolResultEvent(index + 1) })),
        records,
      ),
    })
    const history = await historyPromise

    expect(history.events).toHaveLength(records)
    expect(history.events[0]?.sequence).toBe(1)
    expect(history.events.at(-1)?.sequence).toBe(records)
    // The snapshot envelope validation must not decode rows; only the single
    // history expansion pass may admit them (the double decode ran 2x).
    expect(counter.validateEventCalls).toBe(records)
    await transport.close?.()
  })

  it('does not decode the follow tail when paginating for an older page', async () => {
    FakeWebSocket.instances.length = 0
    const counter = { validateEventCalls: 0 }
    const tailRecords = 300
    const pageRecords = 10
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('the page request body is missing')
      const body = JSON.parse(init.body) as Record<string, unknown>
      if (typeof body.rpcId !== 'string') throw new Error('the page request id is missing')
      return Promise.resolve(
        rpcResponse(body.rpcId, {
          records: Array.from({ length: pageRecords }, (_, index) => ({
            type: 'event',
            event: toolResultEvent(tailRecords - pageRecords + 1 + index),
          })),
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
      sessionWireProfile: countingProfile(counter),
    })
    const sessions = new Rc6SessionRepository(transport)
    const historyPromise = sessions.history('s1', tailRecords + 1)
    const follow = await waitForOpen('session/follow', 0)
    follow.socket.message({
      type: 'item',
      streamId: follow.streamId,
      value: snapshotFrame(
        Array.from({ length: tailRecords }, (_, index) => ({
          type: 'event',
          event: toolResultEvent(index + 1),
        })),
        tailRecords,
      ),
    })
    const history = await historyPromise

    expect(history.events).toHaveLength(pageRecords)
    expect(history.events[0]?.sequence).toBe(tailRecords - pageRecords + 1)
    expect(fetch).toHaveBeenCalledTimes(1)
    // Only the returned page rows are decoded; the tail snapshot serves the
    // cursor and must stay undecoded (the old path decoded tail + page).
    expect(counter.validateEventCalls).toBe(pageRecords)
    await transport.close?.()
  })
})
