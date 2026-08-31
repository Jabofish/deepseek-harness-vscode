import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '@dsh-vscode/domain'
import type { BackendEvent } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import { DshStreamController } from '../src/stream-controller.js'

describe('DshStreamController', () => {
  const controllers: DshStreamController[] = []

  afterEach(async () => {
    await Promise.all(controllers.splice(0).map((controller) => controller.close()))
  })

  it('keeps projection keys that share one durable event sequence', async () => {
    const sessionId = 's1'
    const sequence = 4
    const transport = streamTransport([
      {
        payload: { type: 'session/subscribed', sessionId, lastSeq: sequence - 1 },
      },
      {
        payload: {
          type: 'session/projection',
          sessionId,
          key: 'tokenUsage',
          value: { uncachedInputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
          seq: sequence,
        },
      },
      {
        payload: {
          type: 'session/projection',
          sessionId,
          key: 'contextPressure',
          value: { pressureTokens: 12, projectedTokens: 12, contextWindow: 128_000 },
          seq: sequence,
        },
      },
    ])
    const received: string[] = []
    const controller = new DshStreamController(transport)
    controllers.push(controller)
    controller.subscribe((event) => {
      if (event.type === 'session.projection') received.push(event.key)
    })

    await waitFor(() => received.length === 2)
    expect(received).toEqual(['tokenUsage', 'contextPressure'])
  })

  it('restarts the stream for a listener that subscribes during teardown', async () => {
    const transport = streamTransport([
      { payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 0 } },
    ])
    const received: string[] = []
    const controller = new DshStreamController(transport)
    controllers.push(controller)
    const first = controller.subscribe((event) => received.push(`first:${event.type}`))
    first()
    // Re-subscribe while the aborted generation is still unwinding: the
    // reader promise exists, so subscribe() cannot start a stream itself.
    controller.subscribe((event) => received.push(`second:${event.type}`))

    await waitFor(() => received.includes('second:session.subscribed'))
    expect(received.filter((entry) => entry.startsWith('second:'))).toEqual(['second:session.subscribed'])
  })

  it('restarts the reconnect backoff after a generation proved the stream alive', async () => {
    // A streamSource-based controller (alpha workspace/session streams) never
    // sees a session/subscribed frame, so its backoff level previously only
    // ratcheted up across generations: a healthy generation followed by a
    // clean end still waited seconds for the next reconnect. Any received
    // frame proves the transport alive and must restart the backoff ladder.
    const healthyGeneration = [{ payload: { type: 'host/workspace-changed', workspaceId: 'w1' } }]
    let generation = 0
    const open = (): AsyncIterable<unknown> => {
      generation += 1
      const frames = generation <= 3 ? healthyGeneration : []
      return {
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
          let index = 0
          return {
            async next() {
              await Promise.resolve()
              if (frames.length === 0) throw new Error('stream down after healthy generations')
              return index < frames.length
                ? { done: false as const, value: frames[index++] }
                : { done: true as const, value: undefined }
            },
          }
        },
      }
    }
    const controller = new DshStreamController(
      { ...streamTransport([]), close: () => Promise.resolve() },
      undefined,
      undefined,
      {
        streamSource: open,
        closeTransport: false,
      },
    )
    controllers.push(controller)
    controller.subscribe(() => undefined)

    // Three healthy generations plus the failing one open immediately or at
    // the 250ms base backoff; without the reset the fourth open waits ~1s and
    // the fifth ~2s, so five opens within 2s is only reachable with a reset.
    await waitForAtMost(() => generation >= 5, 2_000)
    await controller.close()
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
    await new Promise((resolve) => setTimeout(resolve, 80))
    // The reconnect backoff is at least 250ms, so a failing stream must not
    // burn generations (and connection.lost notices) in a microtask loop.
    expect(received.filter((type) => type === 'connection.lost')).toHaveLength(1)
  })

  it('releases sequence watermarks when a session is removed', async () => {
    const sessionId = 's1'
    const transport = streamTransport([
      { payload: { type: 'session/subscribed', sessionId, lastSeq: 9 } },
      { payload: { type: 'session/projection', sessionId, key: 'title', value: 'old', seq: 9 } },
      { payload: { type: 'host/session-removed', sessionId } },
      { payload: { type: 'session/subscribed', sessionId, lastSeq: 0 } },
      { payload: { type: 'session/projection', sessionId, key: 'title', value: 'new', seq: 0 } },
    ])
    const values: unknown[] = []
    const controller = new DshStreamController(transport)
    controllers.push(controller)
    controller.subscribe((event) => {
      if (event.type === 'session.projection') values.push(event.value)
    })

    await waitFor(() => values.length === 2)
    expect(values).toEqual(['old', 'new'])
  })

  it('resumes live events when the host re-subscribes below the cached watermark', async () => {
    // The v1 mux ignores the client's `since` resume hook and re-subscribes
    // from the host's own lastSeq baseline. When a host returns with a shorter
    // session log (no session-removed notice), the cached watermark refers to
    // entries the host no longer has: the controller must follow the host's
    // baseline down instead of silently dropping the new event epoch.
    const sessionId = 's1'
    const transport = reconnectingTransport([
      [
        { payload: { type: 'session/subscribed', sessionId, lastSeq: 9 } },
        {
          payload: {
            type: 'session/event',
            sessionId,
            event: { type: 'turn/end', seq: 9, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
          },
        },
      ],
      [
        { payload: { type: 'session/subscribed', sessionId, lastSeq: 2 } },
        {
          payload: {
            type: 'session/event',
            sessionId,
            event: { type: 'turn/end', seq: 3, time: 2, data: { turn: 2, reason: { kind: 'completed' } } },
          },
        },
      ],
    ])
    const received: BackendEvent[] = []
    const controller = new DshStreamController(transport)
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitForAtMost(
      () =>
        received.some(
          (event) =>
            event.type === 'turn.ended' &&
            event.sequence === 3 &&
            'sessionId' in event &&
            event.sessionId === sessionId,
        ),
      2_000,
    )
  })

  it('forwards the durable turn end and host idle status from rc.6 frames', async () => {
    const sessionId = 's1'
    const transport = streamTransport([
      { payload: { type: 'session/subscribed', sessionId, lastSeq: 0 } },
      {
        payload: {
          type: 'session/event',
          sessionId,
          event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
        },
      },
      {
        payload: {
          type: 'session/event',
          sessionId,
          event: {
            type: 'assistant/message',
            seq: 2,
            time: 2,
            data: { turn: 1, step: 0, markdown: 'done' },
          },
        },
      },
      {
        payload: {
          type: 'session/event',
          sessionId,
          event: { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
        },
      },
      { payload: { type: 'host/session-status', sessionId, running: false } },
    ])
    const received: string[] = []
    const controller = new DshStreamController(transport)
    controllers.push(controller)
    controller.subscribe((event) => received.push(event.type))

    await waitFor(() => received.includes('session.status'))
    expect(received).toEqual([
      'session.subscribed',
      'turn.started',
      'message.completed',
      'turn.ended',
      'session.status',
    ])
  })

  it('keeps future frame types as redacted unknown events', async () => {
    const received: BackendEvent[] = []
    const controller = new DshStreamController(
      streamTransport([
        {
          payload: {
            type: 'future/frame',
            sessionId: 's1',
            seq: 3,
            token: 'secret',
            path: 'C:\\private\\file.txt',
            data: { text: 'x'.repeat(2_000) },
            safe: 'ok',
          },
        },
      ]),
    )
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitFor(() => received.some((event) => event.type === 'unknown'))
    const unknown = received.find((event) => event.type === 'unknown')
    expect(unknown).toMatchObject({ type: 'unknown', name: 'future/frame', sessionId: 's1', sequence: 3 })
    expect(JSON.stringify(unknown)).not.toContain('secret')
    expect(JSON.stringify(unknown)).not.toContain('private')
    expect(JSON.stringify(unknown)).toContain('ok')
    expect(JSON.stringify(unknown)).not.toContain('x'.repeat(513))
  })

  it('keeps frame types removed from the pinned schema in the unknown bucket', async () => {
    const received: BackendEvent[] = []
    const controller = new DshStreamController(
      streamTransport([{ payload: { type: 'session/title', sessionId: 's1', title: 'stale' } }]),
    )
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitFor(() => received.some((event) => event.type === 'unknown'))
    expect(received.find((event) => event.type === 'unknown')).toMatchObject({
      type: 'unknown',
      name: 'session/title',
      sessionId: 's1',
    })
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
      reason: 'DSH event stream reported internal: request failed token: [redacted]',
    })
  })

  it('includes safe transport context when a stream reader fails', async () => {
    const received: BackendEvent[] = []
    const failingStream: NonNullable<DshTransport['openMuxStream']> = (_signal) => ({
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {
          async next() {
            await Promise.resolve()
            throw new AppError({
              code: 'BACKEND_UNREACHABLE',
              message: 'request failed',
              retryable: true,
              context: { method: 'session.history', status: 503 },
            })
          },
        }
      },
    })
    const transport: DshTransport = {
      ...streamTransport([]),
      openMuxStream: failingStream,
    }
    const controller = new DshStreamController(transport)
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitFor(() => received.some((event) => event.type === 'connection.lost'))
    expect(received.find((event) => event.type === 'connection.lost')).toMatchObject({
      reason: 'DSH event stream request session.history failed (HTTP 503).',
    })
  })
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

function recoveredTurn(sessionId: string, sequence: number): BackendEvent {
  return { type: 'turn.started', sessionId, turn: 1, sequence } as unknown as BackendEvent
}

describe('DshStreamController detached gap recovery', () => {
  const controllers: DshStreamController[] = []

  afterEach(async () => {
    await Promise.all(controllers.splice(0).map((controller) => controller.close()))
  })

  it('delivers the live event first and replays the hole below the watermark', async () => {
    const stream = new ControlledStream()
    const recovered: Array<[string, number, number]> = []
    const controller = new DshStreamController(
      streamTransport([]),
      undefined,
      async (sessionId, fromSequence, toSequence) => {
        recovered.push([sessionId, fromSequence, toSequence])
        return Promise.resolve([6, 7, 8, 9].map((sequence) => recoveredTurn('s1', sequence)))
      },
      { streamSource: stream.source, closeTransport: false },
    )
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(subscribeFrame('s1', 5))
    await waitFor(() => received.some((event) => event.type === 'session.subscribed'))
    stream.push(liveTurnFrame('s1', 10))
    // The live event must not wait for the history replay; recovery runs
    // detached so the read loop keeps draining the host's frames.
    await waitFor(() => received.some((event) => event.sequence === 10))
    await waitFor(() => received.some((event) => event.sequence === 6))
    await waitFor(() => received.some((event) => event.sequence === 9))

    expect(recovered).toEqual([['s1', 6, 9]])
    expect(received.findIndex((event) => event.sequence === 10)).toBeLessThan(
      received.findIndex((event) => event.sequence === 6),
    )
    expect(received.some((event) => event.type === 'session.gap')).toBe(false)
    // The watermark stays at the live edge: a redelivered older frame is
    // still deduplicated, and recovery never rewinds it.
    stream.push(liveTurnFrame('s1', 9))
    stream.push(liveTurnFrame('s1', 11))
    await waitFor(() => received.some((event) => event.sequence === 11))
    expect(received.filter((event) => event.sequence === 9)).toHaveLength(1)
  })

  it('announces the whole hole as a gap when history recovery fails', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(
      streamTransport([]),
      undefined,
      () => Promise.reject(new Error('history is unavailable')),
      { streamSource: stream.source, closeTransport: false },
    )
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(subscribeFrame('s1', 5))
    await waitFor(() => received.some((event) => event.type === 'session.subscribed'))
    stream.push(liveTurnFrame('s1', 10))
    await waitFor(() => received.some((event) => event.type === 'session.gap'))
    const gap = received.find((event) => event.type === 'session.gap')
    expect(gap).toMatchObject({
      type: 'session.gap',
      sessionId: 's1',
      fromSequence: 6,
      toSequence: 9,
    })
    // The live event still reached consumers despite the failed replay.
    expect(received.some((event) => event.sequence === 10)).toBe(true)
  })

  it('announces the uncovered remainder after a partial history replay', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(
      streamTransport([]),
      undefined,
      () => Promise.resolve([recoveredTurn('s1', 6)]),
      { streamSource: stream.source, closeTransport: false },
    )
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(subscribeFrame('s1', 5))
    await waitFor(() => received.some((event) => event.type === 'session.subscribed'))
    stream.push(liveTurnFrame('s1', 10))
    await waitFor(() => received.some((event) => event.type === 'session.gap'))
    expect(received.find((event) => event.type === 'session.gap')).toMatchObject({
      type: 'session.gap',
      sessionId: 's1',
      fromSequence: 7,
      toSequence: 9,
    })
  })

  it('emits the gap synchronously when no recovery callback is configured', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: stream.source,
      closeTransport: false,
    })
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(subscribeFrame('s1', 5))
    await waitFor(() => received.some((event) => event.type === 'session.subscribed'))
    stream.push(liveTurnFrame('s1', 10))
    await waitFor(() => received.some((event) => event.sequence === 10))
    const gapIndex = received.findIndex((event) => event.type === 'session.gap')
    expect(gapIndex).toBeGreaterThanOrEqual(0)
    expect(received.findIndex((event) => event.sequence === 10)).toBeGreaterThan(gapIndex)
    expect(received[gapIndex]).toMatchObject({ fromSequence: 6, toSequence: 9 })
  })

  it('serializes recoveries per session and aborts them on close', async () => {
    const stream = new ControlledStream()
    const releaseFirst = { resolve: (): void => undefined }
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst.resolve = resolve
    })
    const recoverSignals: AbortSignal[] = []
    const controller = new DshStreamController(
      streamTransport([]),
      undefined,
      async (_sessionId, _from, _to, signal) => {
        recoverSignals.push(signal)
        if (recoverSignals.length === 1) await firstBarrier
        return []
      },
      { streamSource: stream.source, closeTransport: false },
    )
    controllers.push(controller)
    controller.subscribe(() => undefined)

    stream.push(subscribeFrame('s1', 0))
    await new Promise((resolve) => setTimeout(resolve, 10))
    stream.push(liveTurnFrame('s1', 10))
    await new Promise((resolve) => setTimeout(resolve, 10))
    stream.push(liveTurnFrame('s1', 20))
    await new Promise((resolve) => setTimeout(resolve, 10))
    // Both holes queued for one session; only the first recovery is running.
    expect(recoverSignals).toHaveLength(1)
    releaseFirst.resolve()
    await waitFor(() => recoverSignals.length === 2)
    await controller.close()
    expect(recoverSignals.every((signal) => signal.aborted)).toBe(true)
    // Closing while the second recovery runs must not leave it hanging.
    stream.end()
  })
})

/** Each mux (re)open yields the next generation's frames, then ends the stream. */
function reconnectingTransport(generations: readonly (readonly unknown[])[]): DshTransport {
  let nextGeneration = 0
  const open = async function* (signal: AbortSignal): AsyncIterable<unknown> {
    const index = nextGeneration
    nextGeneration += 1
    yield* generations[index] ?? generations[generations.length - 1] ?? []
    if (index >= generations.length - 1) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  }
  return {
    request: <T>() => Promise.reject<T>(new Error('request is not used by this test')),
    remoteRequest: <T>() => Promise.reject<T>(new Error('remoteRequest is not used by this test')),
    openEventStream: open,
    openMuxStream: open,
    close: () => Promise.resolve(),
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
  expect(predicate()).toBe(true)
}

/** Waits long enough for a reconnect backoff to elapse before asserting. */
async function waitForAtMost(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !predicate()) await new Promise((resolve) => setTimeout(resolve, 25))
  expect(predicate()).toBe(true)
}
