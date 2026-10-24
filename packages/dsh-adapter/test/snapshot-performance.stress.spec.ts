import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, it } from 'vitest'
import type { BackendEvent } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import { DshStreamController } from '../src/stream-controller.js'

it.each([
  { records: 1_674, workMs: 0 },
  { records: 10_000, workMs: 0 },
  { records: 128, workMs: 5 },
])(
  'keeps $records snapshot rows responsive with $workMs ms subscriber work',
  { tags: ['stress'], timeout: 15_000 },
  async ({ records, workMs }) => {
    const payload = 'x'.repeat(2_048)
    const rows: BackendEvent[] = Array.from({ length: records }, (_, sequence) => ({
      type: 'message.user',
      sessionId: 's1',
      messageId: `m-${sequence}`,
      source: 'user',
      markdown: payload,
      sequence,
    }))
    const source = async function* (signal: AbortSignal): AsyncGenerator<BackendEvent> {
      yield* rows
      yield { type: 'session.subscribed', sessionId: 's1', lastSequence: records - 1 }
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
    const controller = new DshStreamController(transport, undefined, undefined, {
      streamSource: source,
      normalizeEvent: (frame) => frame as BackendEvent,
    })
    const histogram = monitorEventLoopDelay({ resolution: 10 })
    let delivered = 0
    let ordered = true
    let finish = (): void => undefined
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    histogram.enable()
    try {
      await sleep(25)
      const started = performance.now()
      controller.subscribe((event) => {
        if (event.type === 'session.subscribed') finish()
        if (event.type !== 'message.user') return
        ordered &&= event.sequence === delivered
        delivered++
        const until = performance.now() + workMs
        while (performance.now() < until) {
          /* Explicit downstream CPU pressure. */
        }
      })
      await done
      const elapsed = performance.now() - started
      // Capture the timer delayed by replay; an empty histogram must never pass.
      await sleep(25)
      expect(delivered).toBe(records)
      expect(ordered).toBe(true)
      expect(histogram.count).toBeGreaterThan(0)
      expect(histogram.max / 1_000_000).toBeLessThan(250)
      if (records === 1_674 && workMs === 0) expect(elapsed).toBeLessThan(1_000)
    } finally {
      histogram.disable()
      await controller.close()
    }
  },
)
