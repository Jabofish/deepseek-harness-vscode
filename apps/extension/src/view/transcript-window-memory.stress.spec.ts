import { expect, it } from 'vitest'
import type { BackendEvent, SessionHistoryEvent } from '@dsh-vscode/domain'
import { TranscriptWindowService } from './transcript-window.js'
import { sanitizePublicValue } from './public-value.js'

/**
 * Long-session memory behaviour of the host transcript window. Bounded
 * bookkeeping (previews WeakMap, per-resident maps, notice and event caches)
 * must keep steady-state retention flat while a long stream keeps arriving,
 * and switching through many sessions must not accumulate per-session state
 * after dispose.
 */

function settledHeap(): number {
  for (let i = 0; i < 3; i++) globalThis.gc!()
  return process.memoryUsage().heapUsed
}

function completedMessages(sessionId: string, count: number, firstSequence: number): SessionHistoryEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const sequence = firstSequence + index
    return {
      sequence,
      time: '2026-10-14T00:00:00.000Z',
      event: {
        type: 'message.completed',
        sessionId,
        messageId: `m-${sequence}`,
        markdown: `A ${sequence}.`,
        sequence,
      } satisfies BackendEvent,
    }
  })
}

function makeService(): TranscriptWindowService {
  return new TranscriptWindowService({
    read: () => Promise.resolve({ events: [], hasMore: false }),
    publicValue: (value) => sanitizePublicValue(value),
    post: () => Promise.resolve(true),
  })
}

it(
  'keeps transcript memory flat across long streams and session churn',
  { tags: ['stress'], timeout: 300_000 },
  async () => {
    expect(typeof globalThis.gc).toBe('function')
    // Warmup: build and tear down one long session before sampling.
    {
      const warm = makeService()
      const generation = warm.begin('warm')
      warm.installPage('warm', { events: completedMessages('warm', 400, 1), hasMore: false }, generation)
      let sequence = 10_000
      for (let i = 0; i < 20_000; i++)
        warm.accept({
          type: 'message.delta',
          sessionId: 'warm',
          messageId: 'live',
          delta: 'x'.repeat(48),
          sequence: sequence++,
        })
      for (let i = 0; i < 200; i++) await new Promise((resolve) => setImmediate(resolve))
      warm.dispose()
    }

    const baseline = settledHeap()
    const live = makeService()
    const generation = live.begin('long')
    live.installPage('long', { events: completedMessages('long', 1_500, 1), hasMore: false }, generation)
    const samples: number[] = []
    let sequence = 100_000
    for (let batch = 0; batch < 4; batch++) {
      for (let i = 0; i < 20_000; i++)
        live.accept({
          type: 'message.delta',
          sessionId: 'long',
          messageId: 'live',
          delta: 'x'.repeat(48),
          sequence: sequence++,
        })
      for (let i = 0; i < 200; i++) await new Promise((resolve) => setImmediate(resolve))
      samples.push(settledHeap() - baseline)
    }
    console.log(`transcript long-stream samples over baseline: ${samples.join(', ')} bytes`)

    // Steady state: the resident window is bounded by design (nodes, chars,
    // facts); retention must not climb with the stream length.
    expect(samples.at(-1)! - samples[0]!).toBeLessThan(6 * 1024 * 1024)

    // Session churn: rotating sessions must not accumulate residents, notices,
    // or preview entries after the service is torn down.
    for (let session = 0; session < 40; session++) {
      const churn = makeService()
      const id = `churn-${session}`
      const gen = churn.begin(id)
      churn.installPage(id, { events: completedMessages(id, 300, 1), hasMore: false }, gen)
      let seq = 5_000
      for (let i = 0; i < 2_000; i++)
        churn.accept({
          type: 'message.delta',
          sessionId: id,
          messageId: 'live',
          delta: 'y'.repeat(48),
          sequence: seq++,
        })
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
      churn.dispose()
    }
    const afterChurn = settledHeap() - baseline
    console.log(`transcript settled after 40-session churn: ${afterChurn} bytes over baseline`)
    live.dispose()
    const released = settledHeap() - baseline
    console.log(`transcript settled after dispose: ${released} bytes over baseline`)
    expect(released).toBeLessThan(8 * 1024 * 1024)
  },
)
