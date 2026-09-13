import { afterEach, describe, expect, it } from 'vitest'
import type { BackendEvent } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import { DshStreamController } from '../src/stream-controller.js'

/**
 * Uninterpreted frames keep the durable cursor they arrived with so the raw
 * row can stay ordered against its neighbours. The consumer (the Webview
 * store) owns the separate decision whether that row may move the rendered
 * conversation cursor, so these tests pin the adapter half of that contract.
 *
 * The regression they guard: a DSH version bump adds a frame type (or changes
 * a known row shape) the pinned mapper cannot read. If the adapter lost the
 * cursor, a later replay could reorder the conversation around the unknown
 * row; if a consumer spent the cursor on it, a real durable row sharing the
 * same sequence disappeared entirely.
 */
describe('DshStreamController uninterpreted frames', () => {
  const controllers: DshStreamController[] = []

  afterEach(async () => {
    await Promise.all(controllers.splice(0).map((controller) => controller.close()))
  })

  it('keeps the durable cursor of a session event the pinned mapper cannot read', async () => {
    const received: BackendEvent[] = []
    const controller = new DshStreamController(
      streamTransport([
        canonicalFrame('s1', 0, 'turn/start', { turn: 1 }),
        canonicalFrame('s1', 1, 'future/new-event', { turn: 1, detail: 'unreadable' }),
      ]),
    )
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitFor(() => received.some((event) => event.type === 'unknown'))
    expect(received.find((event) => event.type === 'unknown')).toMatchObject({
      type: 'unknown',
      name: 'future/new-event',
      sessionId: 's1',
      sequence: 1,
    })
  })

  it('keeps the durable cursor when a known session event fails canonical validation', async () => {
    const received: BackendEvent[] = []
    const controller = new DshStreamController(
      streamTransport([
        // tool/result without its message envelope: the mapper must not guess,
        // but the row still belongs at durable position 0.
        canonicalFrame('s1', 0, 'tool/result', { turn: 1, step: 1, callId: 'call-1' }),
        canonicalFrame('s1', 1, 'turn/start', { turn: 1 }),
      ]),
    )
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitFor(() => received.some((event) => event.type === 'turn.started'))
    expect(received).toContainEqual(
      expect.objectContaining({ type: 'unknown', name: 'tool/result', sessionId: 's1', sequence: 0 }),
    )
    // The unknown row keeps its place instead of being pushed behind the row
    // that followed it.
    expect(received.map((event) => event.type)).toEqual(['unknown', 'turn.started'])
  })

  it('keeps the durable cursor of an unrecognized top-level frame', async () => {
    const received: BackendEvent[] = []
    const controller = new DshStreamController(
      streamTransport([{ payload: { type: 'session/future-frame', sessionId: 's1', seq: 4, value: 1 } }]),
    )
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitFor(() => received.some((event) => event.type === 'unknown'))
    expect(received.find((event) => event.type === 'unknown')).toMatchObject({
      type: 'unknown',
      name: 'session/future-frame',
      sessionId: 's1',
      sequence: 4,
    })
  })

  it('treats a lower baseline after restart as a new authoritative epoch', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: stream.source,
      closeTransport: false,
    })
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(subscribeFrame('s1', 10))
    stream.push(canonicalFrame('s1', 11, 'turn/start', { turn: 1 }))
    await waitFor(() => received.some((event) => event.type === 'turn.started'))

    // A restarted DSH process can reuse lower sequence values. The restarted
    // controller must follow the host baseline down instead of dropping the
    // new epoch as stale.
    await controller.restart()
    stream.push(subscribeFrame('s1', 3))
    stream.push(canonicalFrame('s1', 4, 'turn/start', { turn: 2 }))

    await waitFor(() => received.filter((event) => event.type === 'turn.started').length === 2)
    expect(received.filter((event) => event.type === 'turn.started').map((event) => event.sequence)).toEqual([
      11, 4,
    ])
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

/** A pushable stream source so tests can drive a reconnect interactively. */
class ControlledStream {
  private readonly pending: unknown[] = []
  private wake: (() => void) | undefined
  private finished = false

  public push(frame: unknown): void {
    if (this.finished) return
    this.pending.push(frame)
    const resume = this.wake
    this.wake = undefined
    resume?.()
  }

  public readonly source = (signal: AbortSignal): AsyncIterable<unknown> => ({
    [Symbol.asyncIterator]: (): AsyncIterator<unknown> => ({
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
    }),
  })
}

function subscribeFrame(sessionId: string, lastSeq: number): unknown {
  return { payload: { type: 'session/subscribed', sessionId, lastSeq } }
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
  expect(predicate()).toBe(true)
}
