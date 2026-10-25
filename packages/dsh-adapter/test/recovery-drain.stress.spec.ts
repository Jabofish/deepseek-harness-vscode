import { expect, it } from 'vitest'
import type { BackendEvent } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import { DshStreamController } from '../src/stream-controller.js'

/**
 * Interleaved recovery holes must stay near-linear in the number of durable
 * positions. The ordered drain previously rescanned `pending` and
 * `skippedSequences` for every missing position, and skip/gap positions did
 * not count against the yield budget, so a recovered range with alternating
 * holes stalled the Extension Host event loop quadratically.
 */

interface InterleavedResult {
  deltas: number
  gaps: { from: number; to: number }[]
  elapsed: number
  ordered: boolean
  recoverCalls: number
}

const results = new Map<number, InterleavedResult>()

async function drainInterleavedHoles(blocks: number): Promise<InterleavedResult> {
  const sessionId = 's1'
  const top = 4 * blocks
  let releaseQueued!: () => void
  const queued = new Promise<void>((resolve) => {
    releaseQueued = resolve
  })
  const deltas: BackendEvent[] = Array.from({ length: blocks }, (_, index) => ({
    type: 'message.delta',
    sessionId,
    messageId: 'm1',
    delta: 'x',
    sequence: 4 * index + 1,
  }))
  const source = async function* (signal: AbortSignal): AsyncGenerator<BackendEvent> {
    yield {
      type: 'session.subscribed',
      sessionId,
      lastSequence: 0,
      projection: { asOfSequence: top, values: {} },
    }
    yield* deltas
    releaseQueued()
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }
  const transport: DshTransport = {
    request: () => Promise.reject(new Error('No RPC in this fixture')),
    remoteRequest: () => Promise.reject(new Error('No Remote RPC in this fixture')),
    openEventStream: source,
    close: () => Promise.resolve(),
  }
  const recoverCalls: number[] = []
  const controller = new DshStreamController(
    transport,
    undefined,
    async (_sessionId, from, to) => {
      recoverCalls.push(from)
      await queued
      // Even positions below the baseline come back as filtered advisory rows
      // (skipped); positions congruent to 0 or 3 mod 4 stay unrecoverable.
      const projections: BackendEvent[] = []
      for (let sequence = from + ((2 - (from % 4) + 4) % 4); sequence <= to; sequence += 4) {
        projections.push({
          type: 'session.projection',
          sessionId,
          key: 'plan',
          value: { v: sequence },
          sequence,
        })
      }
      return projections
    },
    { streamSource: source, normalizeEvent: (frame) => frame as BackendEvent },
  )
  const received: BackendEvent[] = []
  let ordered = true
  let lastDelta = 0
  try {
    const started = performance.now()
    controller.subscribe((event) => {
      if (event.type === 'message.delta') {
        ordered &&= event.sequence! > lastDelta
        lastDelta = event.sequence!
        received.push(event)
      } else if (event.type === 'session.gap') received.push(event)
    })
    const deadline = performance.now() + 120_000
    while (received.filter((event) => event.type === 'message.delta').length < blocks) {
      if (performance.now() > deadline) throw new Error(`delivery stalled at ${received.length} events`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return {
      deltas: received.filter((event) => event.type === 'message.delta').length,
      gaps: received
        .filter((event) => event.type === 'session.gap')
        .map((event) => ({ from: event.fromSequence, to: event.toSequence })),
      elapsed: performance.now() - started,
      ordered,
      recoverCalls: recoverCalls.length,
    }
  } finally {
    await controller.close()
  }
}

it.each([
  { blocks: 5_000, positions: 20_000 },
  { blocks: 20_000, positions: 80_000 },
])(
  'keeps interleaved recovery holes linear at $positions positions',
  { tags: ['stress'], timeout: 180_000 },
  async ({ blocks, positions }) => {
    // Compare warmed medians rather than a single small sample followed by
    // one large sample: JIT/GC and host scheduling can dominate that ratio.
    // Keep the original scaling limit and verify every trial's delivery.
    await drainInterleavedHoles(2_000)
    const trials: InterleavedResult[] = []
    for (let trial = 0; trial < 3; trial++) {
      const sample = await drainInterleavedHoles(blocks)
      expect(sample.deltas).toBe(blocks)
      expect(sample.ordered).toBe(true)
      expect(sample.gaps).toHaveLength(blocks - 1)
      expect(sample.gaps[0]).toEqual({ from: 3, to: 4 })
      expect(sample.gaps.at(-1)).toEqual({ from: 4 * blocks - 5, to: 4 * blocks - 4 })
      trials.push(sample)
    }
    const result = [...trials].sort((left, right) => left.elapsed - right.elapsed)[1]!
    results.set(blocks, result)
    // Every fourth position is a live delta, the next is a filtered projection,
    // and the remaining two form one explicit gap notice per block.
    expect(result.deltas).toBe(blocks)
    expect(result.ordered).toBe(true)
    expect(result.gaps).toHaveLength(blocks - 1)
    expect(result.gaps[0]).toEqual({ from: 3, to: 4 })
    expect(result.gaps.at(-1)).toEqual({ from: 4 * blocks - 5, to: 4 * blocks - 4 })
    console.log(
      `recovery-drain ${positions}: median=${result.elapsed.toFixed(1)}ms trials=${trials.map((trial) => trial.elapsed.toFixed(1)).join(',')} recoverCalls=${result.recoverCalls}`,
    )
    if (results.has(5_000) && results.has(20_000)) {
      const small = results.get(5_000)!.elapsed
      const large = results.get(20_000)!.elapsed
      // Quadratic scanning shows ~16x across a 4x input; linear work stays
      // close to 4x. The floor keeps fast machines from dividing noise.
      expect(large).toBeLessThan(5.5 * Math.max(small, 50))
    }
  },
)

it(
  'yields while a recovered range contains only skipped and gapped positions',
  { tags: ['stress'], timeout: 120_000 },
  async () => {
    // One wide recovery range whose rows are all baseline-filtered projections:
    // the walk advances over skips and gap notices only. Neither branch counted
    // against the yield budget before, so the whole range advanced in one
    // synchronous run and a 0ms timer could not fire until it finished.
    const sessionId = 's1'
    const blocks = 10_000
    const top = 4 * blocks
    let releaseQueued!: () => void
    const queued = new Promise<void>((resolve) => {
      releaseQueued = resolve
    })
    const source = async function* (signal: AbortSignal): AsyncGenerator<BackendEvent> {
      yield {
        type: 'session.subscribed',
        sessionId,
        lastSequence: 0,
        projection: { asOfSequence: top, values: {} },
      }
      yield { type: 'message.delta', sessionId, messageId: 'm1', delta: 'x', sequence: 1 }
      yield { type: 'message.delta', sessionId, messageId: 'm1', delta: 'y', sequence: top - 3 }
      releaseQueued()
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    const transport: DshTransport = {
      request: () => Promise.reject(new Error('No RPC in this fixture')),
      remoteRequest: () => Promise.reject(new Error('No Remote RPC in this fixture')),
      openEventStream: source,
      close: () => Promise.resolve(),
    }
    let timerScheduledAt = 0
    let timerFiredAt: number | undefined
    let recoverEnteredAt: number | undefined
    const controller = new DshStreamController(
      transport,
      undefined,
      async (_sessionId, from, to) => {
        if (recoverEnteredAt === undefined) {
          recoverEnteredAt = performance.now()
          timerScheduledAt = performance.now()
          setTimeout(() => {
            timerFiredAt = performance.now()
          }, 0)
        }
        await queued
        const projections: BackendEvent[] = []
        for (let sequence = from + (from % 2 === 0 ? 0 : 1); sequence <= to; sequence += 2) {
          projections.push({
            type: 'session.projection',
            sessionId,
            key: 'plan',
            value: { v: sequence },
            sequence,
          })
        }
        return projections
      },
      { streamSource: source, normalizeEvent: (frame) => frame as BackendEvent },
    )
    const gaps: { from: number; to: number }[] = []
    let deltaCount = 0
    let deliveredAt = 0
    try {
      controller.subscribe((event) => {
        if (event.type === 'message.delta') {
          deltaCount++
          if (deltaCount === 2) deliveredAt = performance.now()
        } else if (event.type === 'session.gap') gaps.push({ from: event.fromSequence, to: event.toSequence })
      })
      const deadline = performance.now() + 120_000
      while (deltaCount < 2) {
        if (performance.now() > deadline) throw new Error(`delivery stalled at ${deltaCount} deltas`)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(deltaCount).toBe(2)
      expect(gaps).toHaveLength(2 * blocks - 3)
      expect(recoverEnteredAt).toBeGreaterThan(0)
      expect(timerFiredAt).toBeGreaterThan(0)
      const starvedMs = timerFiredAt! - timerScheduledAt
      console.log(
        `recovery-drain skip/gap walk ${2 * blocks} positions: timerStarvation=${starvedMs.toFixed(1)}ms walkMs=${(deliveredAt - recoverEnteredAt!).toFixed(1)}ms`,
      )
      // The heartbeat timer must run during the walk, not only after it.
      expect(starvedMs).toBeLessThan(150)
    } finally {
      await controller.close()
    }
  },
)
