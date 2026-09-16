import { describe, expect, it } from 'vitest'

import type { SessionRepository } from '../../packages/domain/src/backend.js'
import type { SessionHistoryEvent } from '../../packages/domain/src/sessions.js'
import {
  buildTrajectory,
  createTrajectoryProjector,
  isInjectedUserMessage,
  reduceTimelineBatch,
  type TimelineState,
} from '../../packages/timeline/src/index.js'
import { LIVE_TIMEOUT_MS, canConnect, startManagedRuntime } from './harness.js'

const MAX_PAGES = 6
/** How many of the newest registry rows may be sampled before the evidence is a blank-only registry. */
const SESSION_SAMPLE_LIMIT = 5
/** The ledger namespaces every tool record id away from a node id; see `buildTrajectory`. */
const TOOL_RECORD_PREFIX = 'tool\u0000'

/**
 * Live transcript evidence: read a real session's history through the real
 * adapter and reduce every row through the Webview's reducer. History that
 * carries frames this build cannot interpret surfaces here as `unknown` events
 * and raw `event` rows, before a user has to notice them in a transcript.
 * Rows are reduced with the cursor check disabled so the question stays
 * "can this build read the frame", not "does it win the cursor race".
 *
 * The same run also asserts conservation: durable user text, tool calls,
 * assistant text/reasoning and turn terminals must all survive the reducer, the
 * Trajectory ledger must index every one of them, and its incremental projector
 * must agree with the full fold on every prefix. A row that a user can see in
 * DSH but never in this client fails here.
 *
 * The cards derived for first-party tool rows are checked in
 * `tool-cards.spec.ts`: the sampled registry rows here may hold none of those
 * tools, and asserting them against rows that do not exist is how that evidence
 * went vacuous before.
 *
 *   $env:DSH_LIVE_SMOKE = '1'
 *   $env:DSH_LIVE_RUNTIME_VERSION = '0.1.5-rc.1'      # optional; defaults to the pinned runtime
 *   npx vitest run tests/live-dsh/transcript.spec.ts
 *
 * Read-only: it never sends a prompt or writes to the runtime.
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live DSH transcript reduction', () => {
  it(
    'reduces a real session history without losing or unreadable rows',
    async () => {
      const runtime = await startManagedRuntime()
      try {
        const { backend } = runtime
        const sessions = await backend.sessions.list()
        expect(sessions.items.length, 'the live runtime must expose at least one session').toBeGreaterThan(0)

        // The registry is the user's own, so its newest rows can legitimately be
        // blank sessions with no conversation, and the conservation checks below
        // need turns, steps, tool calls and a finished answer. Sample the recent
        // list and keep the richest session that carries a real user turn
        // instead of pinning the evidence to whichever row happens to sort
        // first. Every sampled session is kept: a running-mutation row is rare
        // in a settled history, and the check below has to see all of them to
        // be able to say anything.
        let target = sessions.items[0]
        let rows: readonly SessionHistoryEvent[] = []
        let timeline: TimelineState | undefined
        const sampled: (readonly SessionHistoryEvent[])[] = []
        for (const candidate of sessions.items.slice(0, SESSION_SAMPLE_LIMIT)) {
          const candidateRows = await collectHistory(backend.sessions, candidate.id, MAX_PAGES)
          sampled.push(candidateRows)
          if (
            !candidateRows.some(
              (row) => row.event.type === 'message.user' && !isInjectedUserMessage(row.event),
            )
          )
            continue
          if (timeline !== undefined && candidateRows.length <= rows.length) continue
          target = candidate
          rows = candidateRows
          timeline = reduceTimelineBatch(
            { sessionId: candidate.id, nodes: [], lastSequence: Number.MIN_SAFE_INTEGER },
            candidateRows.map(({ event, sequence }) => ({ event, sequence, advanceSequence: false })),
          )
        }
        expect(target, 'the live runtime must expose at least one session').toBeDefined()
        expect(timeline, 'a sampled session must carry a readable user turn').toBeDefined()
        if (target === undefined || timeline === undefined) return

        const durableUsers = rows.flatMap((row) =>
          row.event.type === 'message.user' && !isInjectedUserMessage(row.event) ? [row.event] : [],
        )
        const injectedUsers = rows.flatMap((row) =>
          row.event.type === 'message.user' && isInjectedUserMessage(row.event) ? [row.event] : [],
        )
        const toolIds = new Set(
          rows.flatMap((row) => (row.event.type === 'tool.updated' ? [row.event.tool.id] : [])),
        )
        const nonCompletedTurnEnds = rows.filter(
          (row) => row.event.type === 'turn.ended' && row.event.reason !== 'completed',
        )
        const unreadable = rows.filter((row) => row.event.type === 'unknown')
        const rawRows = timeline.nodes.filter((node) => node.kind === 'event')

        console.log(`[dsh-live-transcript] session=${target.id} rows=${rows.length} pages<=${MAX_PAGES}`)
        console.log(`[dsh-live-transcript] unreadable=${unreadable.length} rawRows=${rawRows.length}`)
        console.log(`[dsh-live-transcript] kinds=${JSON.stringify(countKinds(timeline))}`)
        for (const [name, count] of Object.entries(countUnknownNames(unreadable))) {
          console.log(`[dsh-live-transcript] unreadable-name ${name} x${count}`)
        }
        console.log(
          `[dsh-live-transcript] conserved users=${durableUsers.length}+${injectedUsers.length} injected tools=${toolIds.size} terminals=${nonCompletedTurnEnds.length}`,
        )

        expect(rows.length, 'the sampled session must carry history').toBeGreaterThan(0)
        // A frame this build reads must never fall back to a raw row: the only
        // raw rows allowed are the frames the adapter already marked unknown.
        expect(rawRows.map((node) => node.name).sort()).toEqual(
          unreadable.map((row) => (row.event.type === 'unknown' ? row.event.name : '')).sort(),
        )
        // A real session must still produce a readable transcript next to those
        // unreadable frames; they are hidden from the default view.
        expect(durableUsers.length, 'the sampled session must carry a real user turn').toBeGreaterThan(0)
        expect(timeline.nodes.length).toBeGreaterThan(0)

        // --- Conservation: the transcript must show what the durable history holds.
        const userNodes = timeline.nodes.filter((node) => node.kind === 'user-message')
        const userNodeById = new Map(userNodes.map((node) => [node.id, node]))
        for (const event of durableUsers)
          expect(
            userNodeById.get(event.messageId)?.markdown,
            `durable user message ${event.messageId} must reach the transcript verbatim`,
          ).toBe(event.markdown)
        // Injected model context keeps the structured source that hides it from
        // the chat: without it the transcript shows a bubble the user never sent.
        expect(
          userNodes
            .filter((node) => node.source !== undefined && node.source.trim().toLowerCase() !== 'user')
            .map((node) => node.id)
            .sort(),
        ).toEqual(injectedUsers.map((event) => event.messageId).sort())

        const toolNodeIds = new Set(timeline.nodes.flatMap((node) => (node.kind === 'tool' ? [node.id] : [])))
        expect(
          [...toolIds].filter((id) => !toolNodeIds.has(id)),
          'every tool call in the durable history must keep a transcript card',
        ).toEqual([])

        const assistantNodes = new Map(
          timeline.nodes.flatMap((node) =>
            node.kind === 'assistant-message' ? [[node.id, node] as const] : [],
          ),
        )
        for (const [messageId, markdown] of finalAssistantFacts(rows, 'markdown'))
          expect(
            assistantNodes.get(messageId)?.markdown,
            `durable assistant text for ${messageId} must survive the reducer`,
          ).toBe(markdown)
        for (const [messageId, reasoning] of finalAssistantFacts(rows, 'reasoning'))
          expect(
            assistantNodes.get(messageId)?.reasoning?.markdown,
            `durable reasoning for ${messageId} must survive the reducer`,
          ).toBe(reasoning)
        for (const [messageId, images] of finalAssistantFacts(rows, 'images'))
          expect(
            assistantNodes.get(messageId)?.images?.length,
            `durable images for ${messageId} must survive the reducer`,
          ).toBe(images.length)

        expect(
          timeline.nodes.filter((node) => node.kind === 'turn-terminal').length,
          'every turn that ended without completing must leave a terminal marker',
        ).toBe(nonCompletedTurnEnds.length)

        // --- Trajectory ledger: the same rows, folded for the Trajectory tab.
        const ledger = buildTrajectory(timeline.nodes)
        const records = ledger.sections.flatMap((section) => section.records)
        expect(
          records.map((record) => record.index),
          'trajectory record indexes must stay continuous across sections',
        ).toEqual(records.map((_, index) => index + 1))
        expect(ledger.recordCount).toBe(records.length)
        expect(
          records.filter((record) => record.kind === 'user').length,
          'every durable user message must open a trajectory turn',
        ).toBe(durableUsers.length)
        const ledgerToolIds = new Set(
          records.flatMap((record) =>
            record.kind === 'tool' && record.id.startsWith(TOOL_RECORD_PREFIX)
              ? [record.id.slice(TOOL_RECORD_PREFIX.length)]
              : [],
          ),
        )
        expect(
          [...toolIds].filter((id) => !ledgerToolIds.has(id)),
          'every tool card must appear in the trajectory ledger',
        ).toEqual([])

        // The live view folds incrementally; every prefix must equal the full
        // fold, or a streaming session shows a ledger the finished one contradicts.
        const projector = createTrajectoryProjector()
        for (let length = 1; length <= timeline.nodes.length; length += 1) {
          const prefix = timeline.nodes.slice(0, length)
          const incremental = projector(prefix)
          if (JSON.stringify(incremental) !== JSON.stringify(buildTrajectory(prefix))) {
            expect.fail(
              `the incremental trajectory projector diverged at node ${length} of ${timeline.nodes.length}`,
            )
          }
        }
        expect(projector(timeline.nodes)).toEqual(ledger)
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

/**
 * The last defined value of one `assistant/message` field per message id: the
 * durable journal can settle the same message more than once, and the reducer
 * keeps the newest defined value just like this.
 */
function finalAssistantFacts<Key extends 'markdown' | 'reasoning' | 'images'>(
  rows: readonly SessionHistoryEvent[],
  key: Key,
): ReadonlyMap<
  string,
  NonNullable<Extract<SessionHistoryEvent['event'], { type: 'message.completed' }>[Key]>
> {
  const facts = new Map<
    string,
    NonNullable<Extract<SessionHistoryEvent['event'], { type: 'message.completed' }>[Key]>
  >()
  for (const row of rows) {
    if (row.event.type !== 'message.completed') continue
    const value = row.event[key]
    if (value !== undefined) facts.set(row.event.messageId, value)
  }
  return facts
}

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

/** How many rows each `unknown` frame name accounts for, for the diagnostic log. */
function countUnknownNames(rows: readonly SessionHistoryEvent[]): Record<string, number> {
  const names: Record<string, number> = {}
  for (const row of rows) {
    if (row.event.type !== 'unknown') continue
    names[row.event.name] = (names[row.event.name] ?? 0) + 1
  }
  return names
}

/** How many nodes of each kind the reduced transcript holds, for the diagnostic log. */
function countKinds(state: TimelineState): Record<string, number> {
  const kinds: Record<string, number> = {}
  for (const node of state.nodes) kinds[node.kind] = (kinds[node.kind] ?? 0) + 1
  return kinds
}
