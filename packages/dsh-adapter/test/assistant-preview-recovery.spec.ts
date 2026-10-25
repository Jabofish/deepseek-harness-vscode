import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackendEvent } from '@dsh-vscode/domain'

import { DshStreamController } from '../src/stream-controller.js'
import {
  AlphaLoopbackApiClient,
  type AlphaWebSocket,
  type AssistantPreviewState,
} from '../src/versions/alpha/transport.js'
import { createAlpha211SessionNormalizer } from '../src/versions/alpha211/tool-preparation.js'
import { endpoint, wrappedResponse as response } from './support/contract-harness.js'

/**
 * The assistant preview is an opt-in transient channel: the host never replays
 * it, so a protocol discontinuity used to switch it off for the rest of the
 * subscription and the transcript could only render the durable settlement —
 * the whole reply at once. These cases pin the recovery contract: re-open the
 * follow stream, adopt its compact baseline, keep streaming.
 */

const sessionId = 'preview-session'

interface SentFrame {
  readonly type: string
  readonly streamId?: string
}

class FakeMuxSocket implements AlphaWebSocket {
  public static readonly instances: FakeMuxSocket[] = []
  public readyState = 0
  public readonly sent: string[] = []
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  public constructor(
    public readonly url: string,
    public readonly options?: unknown,
  ) {
    FakeMuxSocket.instances.push(this)
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
  /** Every `session/follow` subscription this socket received, in order. */
  public opens(): SentFrame[] {
    return this.sent.map((raw) => JSON.parse(raw) as SentFrame).filter((frame) => frame.type === 'open')
  }
  /** Route one logical-stream item to the Nth opened stream. */
  public item(index: number, value: unknown): unknown {
    const open = this.opens()[index]
    if (open?.streamId === undefined) throw new Error(`stream ${String(index)} was never opened`)
    return { type: 'item', streamId: open.streamId, value }
  }
  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const tick = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

async function waitForSocket(): Promise<FakeMuxSocket> {
  await vi.waitFor(() => expect(FakeMuxSocket.instances[0]).toBeDefined())
  return FakeMuxSocket.instances[0]!
}

async function waitForOpens(socket: FakeMuxSocket, count: number): Promise<void> {
  await vi.waitFor(() => expect(socket.opens()).toHaveLength(count), { timeout: 3_000, interval: 10 })
}

function snapshot(assistantStream: Record<string, unknown> = { revision: 0 }): Record<string, unknown> {
  return {
    type: 'snapshot',
    header: { version: 1, id: sessionId, createdAt: 1, isSeeded: false },
    cursor: 0,
    records: [],
    hasMore: false,
    projections: { asOfSeq: 0, values: {} },
    assistantStream,
  }
}

function startFrame(revision: number): Record<string, unknown> {
  return {
    type: 'assistant-stream',
    frame: { type: 'start', attemptId: 'a1', revision, startedAfterSeq: 0, turn: 1, step: 1 },
  }
}

function chunkFrame(revision: number, index: number, text: string): Record<string, unknown> {
  return {
    type: 'assistant-stream',
    frame: {
      type: 'chunk',
      attemptId: 'a1',
      revision,
      index,
      time: 1_000 + index,
      chunk: { type: 'text-delta', index: 0, text },
    },
  }
}

function settlementFrame(seq: number, text: string): Record<string, unknown> {
  return {
    type: 'event',
    event: {
      type: 'assistant/message',
      seq,
      time: 9_000 + seq,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: `m${String(seq)}`,
          role: 'assistant',
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          content: [{ type: 'text', text }],
        },
      },
    },
  }
}

describe('assistant preview recovery', () => {
  it('omits the optional assistant channel for a hidden consumer while retaining durable settlements', async () => {
    FakeMuxSocket.instances.length = 0
    const client = new AlphaLoopbackApiClient({
      endpoint,
      requestTimeoutMs: 2_000,
      retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
      authCookie: () => 'dsh_session=test-cookie',
      webSocket: FakeMuxSocket,
      sessionWireVersion: 'v2',
    })
    const controller = new DshStreamController(client, undefined, undefined, {
      streamSource: (signal) => client.openSessionStream(sessionId, signal, false),
      normalizeEvent: createAlpha211SessionNormalizer(),
      closeTransport: false,
    })
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))
    try {
      const socket = await waitForSocket()
      socket.open()
      await waitForOpens(socket, 1)
      const open = socket.sent
        .map((raw) => JSON.parse(raw) as { type: string; payload?: { args?: Record<string, unknown> } })
        .find((frame) => frame.type === 'open')
      expect(open?.payload?.args).toBeDefined()
      expect(open?.payload?.args).not.toHaveProperty('assistantStream')
      const baseline = snapshot()
      delete baseline.assistantStream
      socket.message(socket.item(0, baseline))
      await tick()
      socket.message(socket.item(0, settlementFrame(1, 'Complete durable answer')))
      await tick()
      expect(
        received.some(
          (event) => event.type === 'message.completed' && event.markdown === 'Complete durable answer',
        ),
      ).toBe(true)
      expect(received.some((event) => event.type === 'message.delta')).toBe(false)
    } finally {
      await controller.close()
      await client.close()
    }
  })
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  it('re-opens the follow stream when a chunk revision skips and keeps streaming', async () => {
    FakeMuxSocket.instances.length = 0
    const previews: AssistantPreviewState[] = []
    const client = new AlphaLoopbackApiClient({
      endpoint,
      requestTimeoutMs: 2_000,
      retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
      authCookie: () => 'dsh_session=test-cookie',
      webSocket: FakeMuxSocket,
      sessionWireVersion: 'v2',
      onAssistantPreview: (state) => previews.push(state),
    })
    const controller = new DshStreamController(client, undefined, undefined, {
      streamSource: (signal) => client.openSessionStream(sessionId, signal),
      normalizeEvent: (frame) => createAlpha211SessionNormalizer()(frame),
      closeTransport: false,
    })
    const deltas: Extract<BackendEvent, { type: 'message.delta' }>[] = []
    controller.subscribe((event) => {
      if (event.type === 'message.delta') deltas.push(event)
    })

    const socket = await waitForSocket()
    socket.open()
    await waitForOpens(socket, 1)
    socket.message(socket.item(0, snapshot()))
    await tick()
    socket.message(socket.item(0, startFrame(1)))
    await tick()
    socket.message(socket.item(0, chunkFrame(2, 0, 'Hello')))
    await tick()
    expect(deltas.map((event) => event.delta)).toEqual(['Hello'])

    // Frame revision 3 is lost on the wire; revision 4 arrives directly.
    const timers = vi.spyOn(globalThis, 'setTimeout')
    socket.message(socket.item(0, chunkFrame(4, 1, ' world')))
    await waitForOpens(socket, 2)
    expect(timers.mock.calls.some((call) => call[1] === 250)).toBe(false)
    timers.mockRestore()
    expect(previews).toEqual([{ status: 'rebased', phase: 'frame' }])

    // The re-opened follow re-delivers the compact baseline of the live attempt.
    // Already delivered immutable chunks are not emitted again while this same
    // follow is repaired: the visible reply must not rewind to its first token.
    socket.message(
      socket.item(
        1,
        snapshot({
          revision: 3,
          activeAttempt: {
            attemptId: 'a1',
            startedAfterSeq: 0,
            turn: 1,
            step: 1,
            nextIndex: 2,
            stream: [{ type: 'text-chunks', time0: 1_000, index: 0, dt: [1], texts: ['Hello', ' world'] }],
          },
        }),
      ),
    )
    await tick()
    socket.message(socket.item(1, chunkFrame(4, 2, ' more')))
    await tick()

    expect(deltas.map((event) => event.delta)).toEqual(['Hello', ' world', ' more'])
    expect(
      deltas.map((event) => [event.transientAttemptId, event.transientIndex, event.transientSequence]),
    ).toEqual([
      ['a1', 0, 1],
      ['a1', 1, 2],
      ['a1', 2, 3],
    ])

    await controller.close()
  })

  it('re-opens when a duplicate durable settlement arrives for the live attempt', async () => {
    FakeMuxSocket.instances.length = 0
    const previews: AssistantPreviewState[] = []
    const client = new AlphaLoopbackApiClient({
      endpoint,
      requestTimeoutMs: 2_000,
      retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
      authCookie: () => 'dsh_session=test-cookie',
      webSocket: FakeMuxSocket,
      sessionWireVersion: 'v2',
      onAssistantPreview: (state) => previews.push(state),
    })
    const controller = new DshStreamController(client, undefined, undefined, {
      streamSource: (signal) => client.openSessionStream(sessionId, signal),
      normalizeEvent: (frame) => createAlpha211SessionNormalizer()(frame),
      closeTransport: false,
    })
    controller.subscribe(() => undefined)

    const socket = await waitForSocket()
    socket.open()
    await waitForOpens(socket, 1)
    socket.message(socket.item(0, snapshot()))
    await tick()
    socket.message(socket.item(0, startFrame(1)))
    await tick()
    socket.message(socket.item(0, chunkFrame(2, 0, 'Hi')))
    await tick()

    socket.message(socket.item(0, settlementFrame(1, 'Hi')))
    await tick()
    socket.message(socket.item(0, settlementFrame(1, 'Hi')))
    await waitForOpens(socket, 2)
    expect(previews).toEqual([{ status: 'rebased', phase: 'settlement' }])

    await controller.close()
  })

  it('stops recovering after repeated failures and keeps the durable reply path', async () => {
    FakeMuxSocket.instances.length = 0
    const previews: AssistantPreviewState[] = []
    const client = new AlphaLoopbackApiClient({
      endpoint,
      requestTimeoutMs: 2_000,
      retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
      authCookie: () => 'dsh_session=test-cookie',
      webSocket: FakeMuxSocket,
      sessionWireVersion: 'v2',
      onAssistantPreview: (state) => previews.push(state),
    })
    const controller = new DshStreamController(client, undefined, undefined, {
      streamSource: (signal) => client.openSessionStream(sessionId, signal),
      normalizeEvent: (frame) => createAlpha211SessionNormalizer()(frame),
      closeTransport: false,
    })
    const completed: string[] = []
    controller.subscribe((event) => {
      if (event.type === 'message.completed' && event.markdown !== undefined) completed.push(event.markdown)
    })

    const socket = await waitForSocket()
    socket.open()
    await waitForOpens(socket, 1)
    socket.message(socket.item(0, snapshot()))
    await tick()

    // Every baseline disagrees with its own compact stream, so the preview can
    // never recover and the transport must fall back to durable-only delivery.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      socket.message(
        socket.item(
          attempt,
          snapshot({
            revision: 5,
            activeAttempt: {
              attemptId: 'a1',
              startedAfterSeq: 0,
              turn: 1,
              step: 1,
              nextIndex: 7,
              stream: [{ type: 'text-chunks', time0: 1_000, index: 0, dt: [], texts: ['x'] }],
            },
          }),
        ),
      )
      await waitForOpens(socket, attempt + 2)
      await tick()
    }

    expect(previews.filter((state) => state.status === 'rebased')).toHaveLength(3)
    expect(previews.filter((state) => state.status === 'disabled')).toEqual([
      { status: 'disabled', phase: 'baseline' },
    ])

    const current = socket.opens().length - 1
    socket.message(socket.item(current, settlementFrame(1, 'durable reply')))
    await tick()
    expect(completed).toEqual(['durable reply'])

    await controller.close()
  })

  it('does not re-open the follow stream when the session is closed during backoff', async () => {
    FakeMuxSocket.instances.length = 0
    const client = new AlphaLoopbackApiClient({
      endpoint,
      requestTimeoutMs: 2_000,
      retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
      authCookie: () => 'dsh_session=test-cookie',
      webSocket: FakeMuxSocket,
      sessionWireVersion: 'v2',
    })
    const controller = new DshStreamController(client, undefined, undefined, {
      streamSource: (signal) => client.openSessionStream(sessionId, signal),
      normalizeEvent: (frame) => createAlpha211SessionNormalizer()(frame),
      closeTransport: false,
    })
    controller.subscribe(() => undefined)

    const socket = await waitForSocket()
    socket.open()
    await waitForOpens(socket, 1)
    socket.message(socket.item(0, snapshot()))
    await tick()
    socket.message(socket.item(0, startFrame(1)))
    await tick()
    socket.message(socket.item(0, chunkFrame(4, 0, 'gap')))
    await waitForOpens(socket, 2)
    // The first repair is immediate; a second invalid baseline enters backoff.
    socket.message(socket.item(1, snapshot({ revision: -1 })))
    for (let step = 0; step < 50; step += 1) await Promise.resolve()

    await controller.close()
    expect(socket.opens()).toHaveLength(2)
  })

  it('does not reset the recovery budget on a single valid chunk when gaps repeat within the recovery window', async () => {
    FakeMuxSocket.instances.length = 0
    const previews: AssistantPreviewState[] = []
    const client = new AlphaLoopbackApiClient({
      endpoint,
      requestTimeoutMs: 2_000,
      retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
      authCookie: () => 'dsh_session=test-cookie',
      webSocket: FakeMuxSocket,
      sessionWireVersion: 'v2',
      onAssistantPreview: (state) => previews.push(state),
    })
    const controller = new DshStreamController(client, undefined, undefined, {
      streamSource: (signal) => client.openSessionStream(sessionId, signal),
      normalizeEvent: (frame) => createAlpha211SessionNormalizer()(frame),
      closeTransport: false,
    })
    controller.subscribe(() => undefined)

    const socket = await waitForSocket()
    socket.open()
    await waitForOpens(socket, 1)

    // Repeat "valid snapshot + 1 valid chunk + immediate revision gap" 4 times within 10s:
    // Previously, the single valid chunk reset consecutiveRecoveries = 0 every time,
    // causing an infinite rebase loop. Now it is bounded at 3 rebased + 1 disabled.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      socket.message(socket.item(attempt, snapshot()))
      await tick()
      socket.message(socket.item(attempt, startFrame(1)))
      await tick()
      socket.message(socket.item(attempt, chunkFrame(2, 0, 'one-valid-chunk')))
      await tick()
      // Immediate revision gap (2 -> 4, skipping 3)
      socket.message(socket.item(attempt, chunkFrame(4, 1, 'gap')))
      await vi.advanceTimersByTimeAsync(1_000)
      await waitForOpens(socket, attempt + 2)
    }

    expect(previews.filter((state) => state.status === 'rebased')).toHaveLength(3)
    expect(previews.filter((state) => state.status === 'disabled')).toEqual([
      { status: 'disabled', phase: 'frame' },
    ])

    // Fresh start frames in the same exhausted window must not re-enable a
    // preview which immediately fails again and re-reads the full history.
    const durable = socket.opens().length - 1
    socket.message(socket.item(durable, snapshot()))
    for (let attempt = 0; attempt < 4; attempt++) {
      socket.message(socket.item(durable, startFrame(1)))
      socket.message(socket.item(durable, chunkFrame(4, 0, 'still gapped')))
      await tick()
    }
    expect(socket.opens()).toHaveLength(durable + 1)
    await vi.advanceTimersByTimeAsync(10_000)
    socket.message(socket.item(durable, startFrame(1)))
    socket.message(socket.item(durable, chunkFrame(4, 0, 'gap after cooldown')))
    await waitForOpens(socket, durable + 2)

    await controller.close()
  })
})
