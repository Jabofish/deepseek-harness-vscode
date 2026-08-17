import { afterEach, describe, expect, it } from 'vitest'
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
