import { monitorEventLoopDelay } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import type { BackendEvent, SessionHistoryEvent } from '@dsh-vscode/domain'
import {
  TRANSCRIPT_MAX_NODES,
  type TranscriptPatch,
  type TranscriptWindow,
} from '@dsh-vscode/webview-protocol'
import { TranscriptWindowService } from './transcript-window.js'
import { sanitizePublicValue } from './public-value.js'

/**
 * Live streaming into an expanded conversation. After the reader scrolls
 * back, every durable delta re-runs the ordered-window reducer plus the
 * bookkeeping passes (live bodies, bounding, change tracking) over the full
 * retained node table, so the per-delta cost must stay bounded and not grow
 * with the transcript length.
 */

const sessionId = 'session-stress'

function completedMessages(count: number, firstSequence: number): SessionHistoryEvent[] {
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

describe('TranscriptWindowService live delta throughput', () => {
  it.each([
    { pages: 9, live: false },
    { pages: 8, live: true },
  ])(
    'keeps delta handling bounded with $pages pages (live=$live)',
    { tags: ['stress'], timeout: 120_000 },
    async ({ pages, live: displayedLive }) => {
      const posted: (TranscriptWindow | TranscriptPatch)[] = []
      let patches = 0
      let olderReads = 0
      const service = new TranscriptWindowService({
        read: (_sessionId, before) => {
          if (before === undefined)
            return Promise.resolve({
              events: completedMessages(1_800, 100_000),
              hasMore: true,
              beforeSequence: 100_000,
            })
          // Each "older" page descends strictly and contributes another
          // bounded block of projected rows to the expanded resident.
          const page = 9 - olderReads
          olderReads++
          const base = page * 10_000
          return Promise.resolve({
            events: completedMessages(400, base),
            hasMore: olderReads < 9,
            ...(olderReads < 9 ? { beforeSequence: base - 5_000 } : {}),
          })
        },
        publicValue: (value) => sanitizePublicValue(value),
        post: (value) => {
          posted.push(value)
          return Promise.resolve(true)
        },
        postPatch: (value) => {
          posted.push(value)
          patches++
          return Promise.resolve(true)
        },
      })
      const generation = service.begin(sessionId)
      const opening = service.installPage(
        sessionId,
        {
          events: completedMessages(1_800, 100_000),
          hasMore: true,
          beforeSequence: 100_000,
        },
        generation,
      )
      expect(opening.nodes.length).toBeGreaterThan(200)
      let expanded = opening
      // A ninth page evicts the live tail and makes the displayed view historical;
      // eight pages exercise streaming publication at the expanded capacity.
      for (let step = 0; step < pages; step++) {
        expanded = await service.navigate(sessionId, 'older', expanded.revision, new AbortController().signal)
      }
      expect(expanded.nodes.length).toBeGreaterThan(TRANSCRIPT_MAX_NODES - 256)

      const deltas = 1_500
      const chunk = 'x'.repeat(48)
      const histogram = monitorEventLoopDelay({ resolution: 10 })
      histogram.enable()
      let accepted = 0
      try {
        const started = performance.now()
        for (let index = 0; index < deltas; index++) {
          const event: BackendEvent = {
            type: 'message.delta',
            sessionId,
            messageId: 'live-msg',
            delta: chunk,
            sequence: 200_000 + index,
          }
          if (!service.accept(event)) throw new Error(`delta ${index} was rejected`)
          accepted++
          // One loop turn per delta mirrors IPC arrival cadence and lets the
          // delay histogram observe each synchronous reduce block.
          await new Promise((resolve) => setImmediate(resolve))
          const latest = posted.at(-1)
          if (latest !== undefined) service.acknowledge(sessionId, latest.revision)
        }
        const elapsed = performance.now() - started
        const perDeltaMs = elapsed / deltas
        console.log(
          `transcript-delta expanded=${expanded.nodes.length} live=${displayedLive}: total=${elapsed.toFixed(1)}ms perDelta=${perDeltaMs.toFixed(3)}ms maxLoopDelay=${(histogram.max / 1e6).toFixed(1)}ms`,
        )
        expect(accepted).toBe(deltas)
        if (displayedLive) expect(patches).toBeGreaterThan(deltas - 2)
        expect(posted).toHaveLength(displayedLive ? deltas : 0)
        expect(expanded.nodes.length).toBeLessThanOrEqual(TRANSCRIPT_MAX_NODES + 64)
        // Preserve the original reducer-only threshold. Publication has its
        // own baseline in the paired Host/schema/Store probe; it performs work
        // this historical-view fixture never measured.
        if (!displayedLive) expect(perDeltaMs).toBeLessThan(2)
        expect(histogram.max / 1_000_000).toBeLessThan(250)
        service.showLatest(sessionId)
        const live = service.fullNode(sessionId, 'live-msg', 0, new AbortController().signal)
        expect(JSON.stringify(live)).toContain(chunk.slice(0, 8))
      } finally {
        histogram.disable()
        service.dispose()
      }
    },
  )
})
