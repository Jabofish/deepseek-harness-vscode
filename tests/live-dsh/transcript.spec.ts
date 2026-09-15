import { describe, expect, it } from 'vitest'

import type { SessionRepository } from '../../packages/domain/src/backend.js'
import type { SessionHistoryEvent } from '../../packages/domain/src/sessions.js'
import { reduceTimelineBatch, type TimelineState } from '../../packages/timeline/src/index.js'
import { LIVE_TIMEOUT_MS, canConnect, startManagedRuntime } from './harness.js'

const MAX_PAGES = 6

/**
 * Live transcript evidence: read a real session's history through the real
 * adapter and reduce every row through the Webview's reducer. History that
 * carries frames this build cannot interpret surfaces here as `unknown` events
 * and raw `event` rows, before a user has to notice them in a transcript.
 * Rows are reduced with the cursor check disabled so the question stays
 * "can this build read the frame", not "does it win the cursor race".
 *
 *   $env:DSH_LIVE_SMOKE = '1'
 *   npx vitest run tests/live-dsh/transcript.spec.ts
 *
 * Read-only: it never sends a prompt or writes to the runtime.
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live DSH transcript reduction', () => {
  it(
    'reduces a real session history without unreadable frames',
    async () => {
      const runtime = await startManagedRuntime()
      try {
        const { backend } = runtime
        const sessions = await backend.sessions.list()
        const target = sessions.items[0]
        expect(target, 'the live runtime must expose at least one session').toBeDefined()
        if (target === undefined) return

        const rows = await collectHistory(backend.sessions, target.id, MAX_PAGES)
        const unreadable = rows.filter((row) => row.event.type === 'unknown')
        const timeline = reduceTimelineBatch(
          { sessionId: target.id, nodes: [], lastSequence: Number.MIN_SAFE_INTEGER },
          rows.map(({ event, sequence }) => ({ event, sequence, advanceSequence: false })),
        )
        const rawRows = timeline.nodes.filter((node) => node.kind === 'event')
        const kinds = countKinds(timeline)

        console.log(`[dsh-live-transcript] rows=${rows.length} pages<=${MAX_PAGES}`)
        console.log(`[dsh-live-transcript] unreadable=${unreadable.length} rawRows=${rawRows.length}`)
        console.log(`[dsh-live-transcript] kinds=${JSON.stringify(kinds)}`)
        for (const [name, count] of Object.entries(countUnknownNames(unreadable))) {
          console.log(`[dsh-live-transcript] unreadable-name ${name} x${count}`)
        }

        expect(rows.length, 'the sampled session must carry history').toBeGreaterThan(0)
        // A frame this build reads must never fall back to a raw row: the only
        // raw rows allowed are the frames the adapter already marked unknown.
        expect(rawRows.map((node) => node.name).sort()).toEqual(
          unreadable.map((row) => (row.event.type === 'unknown' ? row.event.name : '')).sort(),
        )
        // A real session must still produce a readable transcript next to those
        // unreadable frames; they are hidden from the default view.
        expect(kinds['user-message'] ?? 0).toBeGreaterThan(0)
        expect(timeline.nodes.length).toBeGreaterThan(0)
      } finally {
        await runtime.stop()
        const released = !(await canConnect(runtime.snapshot.port))
        console.log(
          `[dsh-live-transcript] managed stop port ${runtime.snapshot.port} released=${String(released)}`,
        )
        expect(released, `loopback port ${runtime.snapshot.port} must be released`).toBe(true)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})

async function collectHistory(
  sessions: SessionRepository,
  sessionId: string,
  maxPages: number,
): Promise<readonly SessionHistoryEvent[]> {
  const pages: SessionHistoryEvent[][] = []
  let beforeSequence: number | undefined
  for (let page = 0; page < maxPages; page += 1) {
    const result = await sessions.history(sessionId, beforeSequence)
    if (result.events.length === 0) break
    pages.push([...result.events])
    if (!result.hasMore) break
    const oldest = result.beforeSequence ?? Math.min(...result.events.map((row) => row.sequence))
    if (!Number.isFinite(oldest) || (beforeSequence !== undefined && oldest >= beforeSequence)) break
    beforeSequence = oldest
  }
  const ordered = pages.reverse().flat()
  const isOrdered = ordered.every((row, index) => {
    const previous = ordered[index - 1]
    return previous === undefined || row.sequence >= previous.sequence
  })
  return isOrdered ? ordered : [...ordered].sort((left, right) => left.sequence - right.sequence)
}

function countUnknownNames(rows: readonly SessionHistoryEvent[]): Record<string, number> {
  const names: Record<string, number> = {}
  for (const row of rows) {
    if (row.event.type !== 'unknown') continue
    names[row.event.name] = (names[row.event.name] ?? 0) + 1
  }
  return names
}

function countKinds(state: TimelineState): Record<string, number> {
  const kinds: Record<string, number> = {}
  for (const node of state.nodes) kinds[node.kind] = (kinds[node.kind] ?? 0) + 1
  return kinds
}
