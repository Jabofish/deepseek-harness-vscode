import { expect, it } from 'vitest'
import type { BackendEvent } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import { DshStreamController } from '../src/stream-controller.js'

/**
 * Long-streaming memory behaviour of the shared stream controller. The
 * ordered-delivery cursor, its min-heap views, and the projection bookkeeping
 * must retain nothing that grows with the number of delivered events: steady
 * state after a forced GC must stay flat across repeated equal-sized batches,
 * and a full teardown must release everything back to the baseline.
 */

function settledHeap(): number {
  for (let i = 0; i < 3; i++) globalThis.gc!()
  return process.memoryUsage().heapUsed
}

const SESSIONS = 3
const BATCH_TICKS = 9_000
const BATCHES = 4
const HOLE_EVERY = 2_000
const HOLE_WIDTH = 40

function startController(onEvent: (event: BackendEvent) => void): {
  readonly next: () => void
  readonly delivered: () => number
  readonly close: () => Promise<void>
} {
  // Events are handed to the controller one at a time through a resolvable
  // queue so accepts interleave with the async drain exactly like a live mux.
  const queued: BackendEvent[] = []
  let wake: (() => void) | undefined
  let finished = false
  let deliveredCount = 0
  let tick = 0
  const source = async function* (signal: AbortSignal): AsyncGenerator<BackendEvent> {
    // Sessions share one generation; each baseline fences every projection
    // key, so advisory rows take the filtered path for the whole run.
    for (let session = 1; session <= SESSIONS; session++) {
      yield {
        type: 'session.subscribed',
        sessionId: `s${session}`,
        lastSequence: 0,
        projection: { asOfSequence: Number.MAX_SAFE_INTEGER - 1, values: {} },
      }
    }
    while (!finished) {
      if (queued.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
        wake = undefined
      }
      while (queued.length > 0) yield queued.shift()!
    }
  }
  const transport: DshTransport = {
    request: () => Promise.reject(new Error('No RPC in this fixture')),
    remoteRequest: () => Promise.reject(new Error('No Remote RPC in this fixture')),
    openEventStream: source,
    close: () => Promise.resolve(),
  }
  const controller = new DshStreamController(
    transport,
    undefined,
    (sessionId, from, to) => {
      // Recovery refills what it is asked for: filtered projection rows for
      // even positions (skipped), message rows for positions 1 mod 4.
      const rows: BackendEvent[] = []
      for (let seq = from; seq <= to; seq++) {
        if (seq % 2 === 0)
          rows.push({
            type: 'session.projection',
            sessionId,
            key: 'plan',
            value: { v: seq },
            sequence: seq,
          })
        else if (seq % 4 === 1)
          rows.push({ type: 'message.delta', sessionId, messageId: 'recovered', delta: 'r', sequence: seq })
      }
      return Promise.resolve(rows)
    },
    { streamSource: source, normalizeEvent: (frame) => frame as BackendEvent },
  )
  controller.subscribe((event) => {
    if (event.type === 'message.delta') deliveredCount++
    onEvent(event)
  })
  const push = (event: BackendEvent): void => {
    queued.push(event)
    wake?.()
  }
  const next = (): void => {
    // One tick advances one session's durable sequence by one. The window at
    // the end of every HOLE_EVERY block is never sent: the next delivered row
    // makes the drain arm its cursor views and cross a recovery range.
    const session = `s${(tick % SESSIONS) + 1}`
    const sequence = Math.floor(tick / SESSIONS)
    tick++
    if (sequence % HOLE_EVERY >= HOLE_EVERY - HOLE_WIDTH) return
    push(
      sequence % 5 === 0
        ? {
            type: 'message.delta',
            sessionId: session,
            messageId: `m-${sequence}`,
            delta: 'x'.repeat(32),
            sequence,
          }
        : {
            type: 'session.projection',
            sessionId: session,
            key: 'usage',
            value: { v: sequence },
            sequence,
          },
    )
  }
  return {
    next,
    delivered: () => deliveredCount,
    close: async () => {
      finished = true
      wake?.()
      await controller.close()
    },
  }
}

async function runTicks(drain: { next: () => void; delivered: () => number }): Promise<void> {
  for (let i = 0; i < BATCH_TICKS; i++) drain.next()
  // Let the async drain and recovery callbacks run to quiescence.
  let stable = 0
  let last = -1
  for (let i = 0; i < 20_000 && stable < 200; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    const now = drain.delivered()
    stable = now === last ? stable + 1 : 0
    last = now
  }
}

it(
  'keeps long-stream memory flat and releases everything on close',
  { tags: ['stress'], timeout: 300_000 },
  async () => {
    expect(typeof globalThis.gc).toBe('function')
    // Warm allocator and code paths with a full controller before sampling.
    const warm = startController(() => undefined)
    await runTicks(warm)
    await warm.close()

    const baseline = settledHeap()
    const live = startController(() => undefined)
    const samples: number[] = []
    for (let batch = 0; batch < BATCHES; batch++) {
      await runTicks(live)
      samples.push(settledHeap() - baseline)
    }
    console.log(
      `stream-controller memory samples over baseline: ${samples.join(', ')} bytes; delivered=${live.delivered()}`,
    )
    expect(live.delivered()).toBeGreaterThan(1_000)
    // Legitimate retention is bounded per session (cursors, dedupe maps); the
    // retained set must not keep climbing with the delivered count.
    expect(samples.at(-1)! - samples[0]!).toBeLessThan(2 * 1024 * 1024)
    await live.close()
    const released = settledHeap() - baseline
    console.log(`stream-controller settled after close: ${released} bytes over baseline`)
    expect(released).toBeLessThan(4 * 1024 * 1024)
  },
)
