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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
  expect(predicate()).toBe(true)
}
