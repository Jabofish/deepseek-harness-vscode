import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackendEvent } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'

import { DshStreamController } from '../src/stream-controller.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('DshStreamController', () => {
  const controllers: DshStreamController[] = []

  afterEach(async () => {
    await Promise.all(controllers.splice(0).map((controller) => controller.close()))
  })

  it('reconnects a live interaction with a missing reply identity and accepts its authoritative replay', async () => {
    const first = new ControlledStream()
    const second = new ControlledStream()
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: controlledGenerationSource([first, second]),
      closeTransport: false,
    })
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))
    first.push(subscribeFrame('s1', 0))
    first.push({
      payload: { type: 'approval/requested', sessionId: 's1', approvalId: 'a1', toolName: 'bash' },
    })
    await waitFor(() => received.some((event) => event.type === 'connection.lost'))
    expect(received.some((event) => event.type === 'permission.requested')).toBe(false)
    await waitForAtMost(() => second.signal !== undefined, 2_000)
    second.push(subscribeFrame('s1', 0))
    second.push({
      rpcId: 'native-response-id',
      payload: { type: 'approval/requested', sessionId: 's1', approvalId: 'a1', toolName: 'bash' },
    })
    await waitFor(() => received.some((event) => event.type === 'permission.requested'))
    const approvals = received.filter((event) => event.type === 'permission.requested')
    expect(approvals).toHaveLength(1)
    expect(approvals[0]?.request).toMatchObject({ id: 'a1', rpcId: 'native-response-id' })
    expect(received.some((event) => event.type === 'connection.restored')).toBe(true)
  })

  it('does not drop the final assistant message when it is in the opening snapshot', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: stream.source,
      closeTransport: false,
    })
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(
      canonicalFrame('s1', 1, 'assistant/message', {
        turn: 5,
        step: 5,
        message: {
          id: 'assistant-final',
          role: 'assistant',
          source: { kind: 'model', provider: 'minimax-cn', model: 'MiniMax-M3' },
          content: [
            {
              type: 'text',
              text: '替换成功 ✅\n\n**结果对比：**\n\n| 行 | 之前 | 现在 |\n|---|---|---|\n| 1 | `Hello, World!` | `Greetings from MiniMax-M3!` |',
            },
          ],
        },
      }),
    )
    stream.push(subscribeFrame('s1', 1))

    await waitFor(() => received.some((event) => event.type === 'message.completed'))
    const completed = received.find((event) => event.type === 'message.completed')
    expect(completed?.type).toBe('message.completed')
    if (completed?.type !== 'message.completed') return
    expect(completed.sequence).toBe(1)
    expect(completed.messageId).toBe('assistant-final')
    expect(completed.markdown).toContain('Greetings from MiniMax-M3!')
  })

  it('keeps reconnect backoff instead of hot-looping a failing stream', async () => {
    const received: string[] = []
    const failingStream: NonNullable<DshTransport['openMuxStream']> = (_signal) => ({
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {
          async next() {
            await Promise.resolve()
            throw new Error('stream down')
          },
        }
      },
    })
    const transport: DshTransport = { ...streamTransport([]), openMuxStream: failingStream }
    const controller = new DshStreamController(transport)
    controllers.push(controller)
    controller.subscribe((event) => received.push(event.type))

    await waitFor(() => received.includes('connection.lost'))
    await vi.advanceTimersByTimeAsync(80)
    // The reconnect backoff is at least 250ms, so a failing stream must not
    // burn generations (and connection.lost notices) in a microtask loop.
    expect(received.filter((type) => type === 'connection.lost')).toHaveLength(1)
  })

  it('does not replay malformed canonical session events as synthetic domain state', async () => {
    const sessionId = 's1'
    const malformed = [
      { type: 'turn/end', data: { turn: 1 } },
      { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta' } } },
      { type: 'assistant/message', data: { turn: 1, step: 1, markdown: 'not canonical' } },
      { type: 'user/message', data: { id: 'user-1', content: [] } },
      {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 2,
          message: {
            id: 'assistant-image-1',
            role: 'assistant',
            content: [{ type: 'image', attachment: { attachmentId: 'missing-metadata' } }],
            source: { kind: 'model', provider: 'provider-1', model: 'model-1' },
          },
        },
      },
      { type: 'tool/call', data: { turn: 1, step: 1, name: 'shell', arguments: '{}' } },
      { type: 'tool/result', data: { turn: 1, step: 1, callId: 'call-1' } },
      { type: 'request/context', data: { provider: 'provider-1' } },
    ] as const
    const transport = streamTransport(
      malformed.map((event, index) => ({
        payload: {
          type: 'session/event',
          sessionId,
          event: { ...event, seq: index + 1, time: index + 1 },
        },
      })),
    )
    const received: BackendEvent[] = []
    const controller = new DshStreamController(transport)
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitFor(() => received.filter((event) => event.type === 'unknown').length === malformed.length)
    const unknown = received.filter((event) => event.type === 'unknown')
    expect(unknown.map((event) => event.type)).toEqual(Array(malformed.length).fill('unknown'))
    expect(unknown.map((event) => ('name' in event ? event.name : undefined))).toEqual(
      malformed.map((event) => event.type),
    )
  })

  it('reports bounded stream error diagnostics without exposing secrets', async () => {
    const received: BackendEvent[] = []
    const controller = new DshStreamController(
      streamTransport([
        {
          payload: {
            type: 'stream/error',
            error: {
              code: 'internal',
              message: 'request failed token=secret',
              details: {},
            },
          },
        },
      ]),
    )
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitFor(() => received.some((event) => event.type === 'connection.lost'))
    const lost = received.find((event) => event.type === 'connection.lost')
    expect(lost).toMatchObject({
      type: 'connection.lost',
      // The scrub replaces the value and keeps the separator it matched, so the
      // diagnostic still reads as the `token=…` pair it came from.
      reason: 'DSH event stream reported internal: request failed token=[redacted]',
    })
  })

  it('cancels a paused snapshot replay and clears its immediate without advancing timers', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: stream.source,
      closeTransport: false,
    })
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))
    for (let sequence = 0; sequence < 129; sequence++)
      stream.push(canonicalFrame('s1', sequence, 'turn/start', { turn: sequence + 1 }))
    stream.push(subscribeFrame('s1', 128))

    await waitFor(() => received.length > 0)
    expect(received.length).toBeLessThan(129)
    expect(vi.getTimerCount()).toBe(1)
    await controller.close()
    expect(vi.getTimerCount()).toBe(0)
    expect(received.every((event) => event.type === 'turn.started')).toBe(true)
  })

  it.each(['opening', 'reconnect'] as const)(
    'yields when %s replay exhausts the time budget',
    async (mode) => {
      let clock = 0
      const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
      const first = new ControlledStream()
      const second = new ControlledStream()
      const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
        streamSource: controlledGenerationSource([first, second]),
        closeTransport: false,
      })
      controllers.push(controller)
      const received: number[] = []
      let subscribed = false
      let callback: NodeJS.Immediate | undefined
      let deliveredAtCallback = 0
      controller.subscribe((event) => {
        if (event.type === 'session.subscribed') subscribed = true
        if (event.type !== 'turn.started' || event.sequence === undefined) return
        received.push(event.sequence)
        clock += 10
        if (received.length === 1)
          callback = setImmediate(() => {
            deliveredAtCallback = received.length
          })
      })
      try {
        if (mode === 'reconnect') {
          first.push(subscribeFrame('s1', 0))
          await waitFor(() => subscribed)
          first.end()
          await waitForAtMost(() => second.signal !== undefined && !second.signal.aborted, 2_000)
          subscribed = false
        }
        const stream = mode === 'opening' ? first : second
        const offset = mode === 'opening' ? 0 : 1
        for (let index = 0; index < 5; index++)
          stream.push(canonicalFrame('s1', index + offset, 'turn/start', { turn: index + 1 }))
        stream.push(subscribeFrame('s1', offset + 4))
        await waitForAtMost(() => received.length === 5 && subscribed, 1_000)
        expect(deliveredAtCallback).toBeGreaterThan(0)
        expect(deliveredAtCallback).toBeLessThan(5)
        expect(received).toEqual(Array.from({ length: 5 }, (_, index) => index + offset))
      } finally {
        clearImmediate(callback)
        now.mockRestore()
      }
    },
  )
})

function streamTransport(frames: readonly unknown[]): DshTransport {
  const open = async function* (signal: AbortSignal): AsyncIterable<unknown> {
    yield* frames
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }
  return {
    request: <T>() => Promise.reject<T>(new Error('request is not used by this test')),
    remoteRequest: <T>() => Promise.reject<T>(new Error('remoteRequest is not used by this test')),
    openEventStream: open,
    openMuxStream: open,
    close: () => Promise.resolve(),
  }
}

/** A pushable stream source so tests can drive gaps and recovery interactively. */
class ControlledStream {
  private readonly pending: unknown[] = []
  private wake: (() => void) | undefined
  private finished = false
  public signal: AbortSignal | undefined

  public push(frame: unknown): void {
    if (this.finished) return
    this.pending.push(frame)
    const resume = this.wake
    this.wake = undefined
    resume?.()
  }

  public end(): void {
    this.finished = true
    this.wake?.()
  }

  public readonly source = (signal: AbortSignal): AsyncIterable<unknown> => {
    this.signal = signal
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<unknown> => {
        return {
          next: async (): Promise<IteratorResult<unknown>> => {
            for (;;) {
              if (this.pending.length > 0) return { done: false as const, value: this.pending.shift() }
              if (this.finished || signal.aborted) return { done: true as const, value: undefined }
              await new Promise<void>((resolve) => {
                this.wake = resolve
                if (signal.aborted) resolve()
                else signal.addEventListener('abort', () => resolve(), { once: true })
              })
            }
          },
        }
      },
    }
  }
}

function subscribeFrame(sessionId: string, lastSeq: number): unknown {
  return { payload: { type: 'session/subscribed', sessionId, lastSeq } }
}

function liveTurnFrame(sessionId: string, seq: number): unknown {
  return {
    payload: {
      type: 'session/event',
      sessionId,
      event: { type: 'turn/start', seq, time: seq, data: { turn: 1 } },
    },
  }
}

function assistantFrame(sessionId: string, transientSequence: number, text: string): unknown {
  return {
    payload: {
      type: 'session/assistant-stream',
      sessionId,
      transientSequence,
      frame: {
        type: 'chunk',
        attemptId: 'attempt-1',
        revision: transientSequence,
        index: transientSequence - 1,
        time: transientSequence,
        turn: 1,
        step: 0,
        chunk: { type: 'text-delta', index: transientSequence - 1, text },
      },
    },
  }
}

function canonicalFrame(sessionId: string, sequence: number, type: string, data: unknown): unknown {
  return {
    payload: {
      type: 'session/event',
      sessionId,
      event: { type, seq: sequence, time: sequence, data },
    },
  }
}

function projectionFrame(sessionId: string, sequence: number, key: string, value: unknown): unknown {
  return {
    payload: { type: 'session/projection', sessionId, key, value, seq: sequence },
  }
}

function recoveredTurn(sessionId: string, sequence: number): BackendEvent {
  return { type: 'turn.started', sessionId, turn: 1, sequence } as unknown as BackendEvent
}

function recoveredMessage(
  sessionId: string,
  sequence: number,
  messageId: string,
  markdown: string,
): BackendEvent {
  return { type: 'message.user', sessionId, messageId, markdown, source: 'user', sequence }
}

function recoveredStep(sessionId: string, sequence: number): BackendEvent {
  return { type: 'step.started', sessionId, turn: 1, step: 1, sequence }
}

function recoveredReasoning(sessionId: string, sequence: number, delta: string): BackendEvent {
  return { type: 'reasoning.delta', sessionId, messageId: 'assistant-1', turn: 1, step: 1, delta, sequence }
}

function recoveredTool(
  sessionId: string,
  sequence: number,
  id: string,
  status: 'completed' | 'running',
  outputSummary?: string,
): BackendEvent {
  return {
    type: 'tool.updated',
    sessionId,
    sequence,
    tool: {
      id,
      name: 'shell',
      category: 'execution',
      title: 'Shell',
      status,
      ...(outputSummary === undefined ? {} : { outputSummary }),
      metadata: {},
    },
  }
}

describe('DshStreamController ordered gap recovery', () => {
  const controllers: DshStreamController[] = []

  afterEach(async () => {
    await Promise.all(controllers.splice(0).map((controller) => controller.close()))
  })

  it('keeps a complex interleaved multi-tool stream complete and ordered during recovery', async () => {
    const stream = new ControlledStream()
    const releaseRecovery = { resolve: (): void => undefined }
    const recoveryBarrier = new Promise<void>((resolve) => {
      releaseRecovery.resolve = resolve
    })
    const recoveryRanges: Array<[number, number]> = []
    const controller = new DshStreamController(
      streamTransport([]),
      undefined,
      async (_sessionId, fromSequence, toSequence) => {
        recoveryRanges.push([fromSequence, toSequence])
        if (recoveryRanges.length === 1) await recoveryBarrier
        return [
          recoveredMessage('s1', 6, 'user-1', 'inspect the repository'),
          recoveredTurn('s1', 7),
          recoveredStep('s1', 8),
          recoveredReasoning('s1', 9, 'I will inspect two tools.'),
          recoveredTool('s1', 11, 'call-1', 'completed', 'first tool result'),
        ].filter(
          (event) =>
            event.sequence !== undefined && event.sequence >= fromSequence && event.sequence <= toSequence,
        )
      },
      { streamSource: stream.source, closeTransport: false },
    )
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(subscribeFrame('s1', 5))
    await waitFor(() => received.some((event) => event.type === 'session.subscribed'))
    stream.push(
      canonicalFrame('s1', 10, 'tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'shell',
        arguments: '{}',
      }),
    )
    stream.push(projectionFrame('s1', 10, 'tokenUsage', { outputTokens: 2 }))
    stream.push(projectionFrame('s1', 10, 'contextPressure', { pressureTokens: 12 }))
    stream.push(
      canonicalFrame('s1', 12, 'tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-2',
        name: 'read',
        arguments: '{"path":"README.md"}',
      }),
    )
    stream.push(
      canonicalFrame('s1', 13, 'tool/result', {
        turn: 1,
        step: 1,
        callId: 'call-2',
        message: {
          id: 'tool-message-2',
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-2',
              content: [{ type: 'text', text: 'README contents' }],
            },
          ],
          source: { kind: 'tool', callId: 'call-2' },
        },
      }),
    )
    stream.push(
      canonicalFrame('s1', 14, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'The repository is consistent.' }],
          source: { kind: 'model', provider: 'provider-1', model: 'model-1' },
        },
      }),
    )
    stream.push(canonicalFrame('s1', 15, 'step/end', { turn: 1, step: 1 }))
    stream.push(canonicalFrame('s1', 16, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))

    // Projection state is allowed to arrive while history is loading, but no
    // durable conversation record may jump over the recovery barrier.
    await vi.advanceTimersByTimeAsync(10)
    expect(received.some((event) => event.sequence === 10 && event.type === 'tool.updated')).toBe(false)
    expect(received.filter((event) => event.type === 'session.projection').map((event) => event.key)).toEqual(
      ['tokenUsage', 'contextPressure'],
    )

    releaseRecovery.resolve()
    await waitFor(() => received.some((event) => event.sequence === 16))

    const durable = received
      .filter((event) => event.type !== 'session.projection' && event.type !== 'session.subscribed')
      .filter((event) => event.sequence !== undefined)
    expect(durable.map((event) => event.sequence)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    expect(durable.map((event) => event.type)).toEqual([
      'message.user',
      'turn.started',
      'step.started',
      'reasoning.delta',
      'tool.updated',
      'tool.updated',
      'tool.updated',
      'tool.updated',
      'message.completed',
      'step.ended',
      'turn.ended',
    ])
    expect(recoveryRanges).toEqual([
      [6, 9],
      [11, 11],
    ])
    expect(received.some((event) => event.type === 'session.gap')).toBe(false)
  })

  it('bounds repeated transient sequence gaps within the recovery window and degrades to durable delivery without restarting', async () => {
    const streams = [
      new ControlledStream(),
      new ControlledStream(),
      new ControlledStream(),
      new ControlledStream(),
    ]
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: controlledGenerationSource(streams),
      closeTransport: false,
    })
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    // Attempts 0, 1, 2: each delivers 1 valid transient frame then a transient gap (1 -> 3)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stream = streams[attempt]!
      stream.push(subscribeFrame('s1', 0))
      await waitFor(
        () => received.filter((event) => event.type === 'session.subscribed').length === attempt + 1,
      )
      stream.push(assistantFrame('s1', 1, `ok-${attempt}`))
      await waitFor(() => received.filter((event) => event.type === 'message.delta').length === attempt + 1)
      // Trigger transient gap (1 -> 3)
      stream.push(assistantFrame('s1', 3, `gap-${attempt}`))
      await vi.advanceTimersByTimeAsync(1_000)
      await waitFor(() => streams[attempt + 1]?.signal !== undefined)
    }

    // Attempt 3 (the 4th transient gap within the window): budget is exhausted,
    // so it must NOT restart into a 5th stream, drops the gapped transient chunk,
    // and keeps stream[3] alive for durable events.
    const finalStream = streams[3]!
    finalStream.push(subscribeFrame('s1', 0))
    await waitFor(() => received.filter((event) => event.type === 'session.subscribed').length === 4)
    finalStream.push(assistantFrame('s1', 1, 'ok-3'))
    finalStream.push(assistantFrame('s1', 3, 'gap-3'))
    finalStream.push(liveTurnFrame('s1', 1))
    await waitFor(() => received.some((event) => event.sequence === 1))

    expect(finalStream.signal?.aborted).toBe(false)
    expect(received.some((event) => event.type === 'message.delta' && event.delta === 'gap-3')).toBe(false)
  })
})

/** Each mux (re)open yields the next generation's frames, then ends the stream. */

function controlledGenerationTransport(generations: readonly ControlledStream[]): DshTransport {
  let nextGeneration = 0
  const open = (signal: AbortSignal): AsyncIterable<unknown> => {
    const stream = generations[nextGeneration] ?? generations[generations.length - 1]
    nextGeneration += 1
    return stream?.source(signal) ?? streamTransport([]).openEventStream(signal)
  }
  return {
    request: <T>() => Promise.reject<T>(new Error('request is not used by this test')),
    remoteRequest: <T>() => Promise.reject<T>(new Error('remoteRequest is not used by this test')),
    openEventStream: open,
    openMuxStream: open,
    close: () => Promise.resolve(),
  }
}

function controlledGenerationSource(
  generations: readonly ControlledStream[],
): (signal: AbortSignal) => AsyncIterable<unknown> {
  const transport = controlledGenerationTransport(generations)
  return (signal) => transport.openEventStream(signal)
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) await vi.advanceTimersByTimeAsync(0)
  expect(predicate()).toBe(true)
}

/** Waits long enough for a reconnect backoff to elapse before asserting. */
async function waitForAtMost(predicate: () => boolean, timeoutMs: number): Promise<void> {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: timeoutMs, interval: 25 })
}
