import { describe, expect, it } from 'vitest'

import type { SessionRepository } from '../../packages/domain/src/backend.js'
import type {
  SessionDetail,
  SessionHistoryPage,
  SessionSequenceRange,
  SessionSummary,
} from '../../packages/domain/src/sessions.js'
import {
  hasLiveHistoryFixture,
  LIVE_TIMEOUT_MS,
  canConnect,
  requireLiveHistoryFixtureHome,
  startManagedRuntime,
} from './harness.js'

/** Upper bound on pages one run may read; a longer Session stops the walk. */
const PAGE_LIMIT = 40

/** How many list rows may be warmed with a detail read before giving up on sampling. */
const CANDIDATE_LIMIT = 12
const skipLiveHistoryProbe = process.env.DSH_LIVE_SMOKE !== '1' || !hasLiveHistoryFixture()

/**
 * Live paging evidence for the "load older" path. `session.history` without a
 * cursor answers with the newest window; every later page is requested with the
 * previous page's `beforeSeq` and must move strictly older, stay contiguous and
 * terminate. The Webview merges those pages into one transcript and reports the
 * uncovered runs as history gaps, so a stall, an overlap or a hole here is a
 * user-visible defect.
 *
 *   $env:DSH_LIVE_SMOKE = '1'
 *   $env:DSH_LIVE_RUNTIME_VERSION = '0.1.6-alpha.1'
 *   npx vitest run tests/live-dsh/paging.spec.ts
 *
 * It never sends a prompt or a DSH write request. Startup state stays inside
 * the disposable history fixture. Only the process started here is signalled;
 * an external DSH is never touched.
 */
describe.skipIf(skipLiveHistoryProbe)('live DSH history paging', () => {
  it(
    'walks a real Session backwards to its first event without stalling, overlapping or hiding a hole',
    async () => {
      const runtime = await startManagedRuntime({ dshHome: requireLiveHistoryFixtureHome() })
      const evidence: string[] = []
      const divergences: string[] = []
      let released: boolean | undefined
      try {
        const { backend } = runtime
        const unsubscribe = backend.events.subscribe(() => undefined)
        try {
          const target = await sampleLongSession(backend.sessions, evidence)
          if (target === undefined) {
            divergences.push('the history fixture must contain at least one Session spanning multiple pages')
          } else {
            await walkBackwards(backend, target, evidence, divergences)
          }
        } finally {
          unsubscribe()
        }
      } finally {
        await runtime.stop()
        released = !(await canConnect(runtime.snapshot.port))
        for (const step of runtime.steps) console.log(`[dsh-live-paging] ${step}`)
        for (const line of evidence) console.log(`[dsh-live-paging] ${line}`)
        for (const line of divergences) console.log(`[dsh-live-paging] DIVERGENCE ${line}`)
        console.log(
          `[dsh-live-paging] managed stop port ${runtime.snapshot.port} released=${String(released)}`,
        )
        expect(released, `loopback port ${runtime.snapshot.port} must be released`).toBe(true)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})

/**
 * Find a Session that really has an older page. Only a Session whose newest
 * window reports `historyHasMore` exercises the cursor path at all, so the walk
 * refuses to claim evidence from a Session the host answers in one page.
 */
async function sampleLongSession(
  backend: Pick<SessionRepository, 'list' | 'get'>,
  evidence: string[],
): Promise<{ readonly sessionId: string; readonly newestSequence: number } | undefined> {
  const page = await backend.list()
  const candidates = page.items.slice(0, CANDIDATE_LIMIT)
  let singlePageSessions = 0
  for (const row of candidates) {
    try {
      const detail = await backend.get(row.id)
      const history = detail.history ?? []
      const newest = history.at(-1)?.sequence
      if (newest === undefined) continue
      if (detail.historyHasMore === true) {
        evidence.push(
          `sampled ${row.id} newestSeq=${newest} rows=${history.length} hasMore=true (cursor path)`,
        )
        return { sessionId: row.id, newestSequence: newest }
      }
      singlePageSessions += 1
    } catch {
      // A Session-kind address can refuse a row that is not a Session at all;
      // sampling walks past it instead of treating the list as unusable.
    }
  }
  if (singlePageSessions > 0)
    evidence.push(`sampled ${singlePageSessions} single-page Session(s); none exercised the cursor path`)
  return undefined
}

describe('sampleLongSession', () => {
  it('does not treat single-page history as cursor-path evidence', async () => {
    const evidence: string[] = []
    const target = await sampleLongSession(
      createPagingProbe([{ id: 'single-page', newestSequence: 42, hasMore: false }]),
      evidence,
    )

    expect(target).toBeUndefined()
    expect(evidence).toContain('sampled 1 single-page Session(s); none exercised the cursor path')
  })

  it('selects a Session only when its detail reports an older page', async () => {
    const target = await sampleLongSession(
      createPagingProbe([
        { id: 'newer-single-page', newestSequence: 900, hasMore: false },
        { id: 'older-paged-session', newestSequence: 21, hasMore: true },
      ]),
      [],
    )

    expect(target).toEqual({ sessionId: 'older-paged-session', newestSequence: 21 })
  })
})

function createPagingProbe(
  samples: readonly {
    readonly id: string
    readonly newestSequence: number
    readonly hasMore: boolean
  }[],
): Pick<SessionRepository, 'list' | 'get'> {
  const byId = new Map(samples.map((sample) => [sample.id, sample] as const))
  return {
    list: () =>
      Promise.resolve({
        items: samples.map(({ id }) => ({ id }) as unknown as SessionSummary),
      }),
    get: (sessionId) => {
      const sample = byId.get(sessionId)
      if (sample === undefined) return Promise.reject(new Error('unknown paging probe session'))
      return Promise.resolve({
        history: [{ sequence: sample.newestSequence }],
        historyHasMore: sample.hasMore,
      } as unknown as SessionDetail)
    },
  }
}

/**
 * Read every page below the newest window. Each page must be strictly older
 * than its cursor, must not repeat a sequence, and its coverage must abut the
 * previous page's coverage so the merged transcript has no false hole.
 */
async function walkBackwards(
  backend: Awaited<ReturnType<typeof startManagedRuntime>>['backend'],
  target: { readonly sessionId: string; readonly newestSequence: number },
  evidence: string[],
  divergences: string[],
): Promise<void> {
  const seen = new Set<number>()
  const covered: SessionSequenceRange[] = []
  let beforeSequence: number | undefined
  let pages = 0
  let newestPublicSequence: number | undefined
  for (;;) {
    const page: SessionHistoryPage = await backend.sessions.history(target.sessionId, beforeSequence)
    pages += 1
    const sequences = page.events.map((entry) => entry.sequence)
    const oldest = page.beforeSequence ?? (sequences.length === 0 ? undefined : Math.min(...sequences))
    evidence.push(
      `page ${pages} cursor=${String(beforeSequence)} rows=${sequences.length} oldest=${String(oldest)} ` +
        `hasMore=${String(page.hasMore)} covered=${describeRanges(page.coveredSequenceRanges)}`,
    )
    const coveredRanges = page.coveredSequenceRanges ?? []
    for (const range of coveredRanges) covered.push(range)
    for (const sequence of sequences) {
      if (seen.has(sequence)) divergences.push(`sequence ${sequence} was returned by two pages`)
      seen.add(sequence)
    }
    if (newestPublicSequence === undefined && sequences.length > 0)
      newestPublicSequence = Math.max(...sequences)
    if (page.events.length > 0 && oldest !== undefined) {
      if (beforeSequence !== undefined && oldest >= beforeSequence)
        divergences.push(
          `page ${pages} starts at ${oldest}, which is not older than the cursor ${beforeSequence}`,
        )
      const pageOldestRow = Math.min(...sequences)
      if (pageOldestRow < oldest)
        divergences.push(`page ${pages} holds sequence ${pageOldestRow} below its own cursor ${oldest}`)
    }
    if (!page.hasMore) {
      if (oldest !== undefined && oldest > 0)
        divergences.push(`the last page starts at ${oldest} instead of the first durable sequence 0`)
      break
    }
    if (oldest === undefined) {
      divergences.push(`page ${pages} claims more history but carries no cursor to continue from`)
      break
    }
    beforeSequence = oldest
    if (pages >= PAGE_LIMIT) {
      divergences.push(`paging did not reach the first event within ${PAGE_LIMIT} pages`)
      break
    }
  }
  evidence.push(
    `walked ${pages} page(s) covering ${seen.size} sequence(s) up to ${String(target.newestSequence)}`,
  )
  // The Webview derives its gap warnings from exactly these runs: a Session the
  // host can read completely must not look like it has a hole in the middle.
  const holes = holesIn(covered)
  if (holes.length > 0)
    divergences.push(`the merged coverage has ${holes.length} hole(s): ${holes.map(describeHole).join(' ')}`)
  const firstCovered = covered.reduce<number | undefined>(
    (lowest, range) => (lowest === undefined || range.from < lowest ? range.from : lowest),
    undefined,
  )
  if (firstCovered !== undefined && firstCovered > 0)
    divergences.push(`the covered history starts at ${firstCovered} instead of the first durable sequence 0`)
  if (newestPublicSequence !== undefined) {
    const lastCovered = covered.reduce((highest, range) => (range.to > highest ? range.to : highest), 0)
    const expectedNewest =
      target.newestSequence === -1 ? -1 : Math.max(target.newestSequence, newestPublicSequence)
    if (lastCovered < expectedNewest)
      evidence.push(`covered runs end at ${lastCovered} while the newest row is ${expectedNewest}`)
  }
}

/** The uncovered gaps between sorted, merged runs — the client's gap detection. */
function holesIn(ranges: readonly SessionSequenceRange[]): readonly SessionSequenceRange[] {
  const merged: SessionSequenceRange[] = []
  for (const range of [...ranges].sort((left, right) => left.from - right.from)) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && range.from <= previous.to + 1) {
      if (range.to > previous.to) merged[merged.length - 1] = { from: previous.from, to: range.to }
      continue
    }
    merged.push(range)
  }
  const holes: SessionSequenceRange[] = []
  for (let index = 1; index < merged.length; index += 1) {
    const previous = merged[index - 1] as SessionSequenceRange
    const current = merged[index] as SessionSequenceRange
    holes.push({ from: previous.to + 1, to: current.from - 1 })
  }
  return holes
}

function describeHole(hole: SessionSequenceRange): string {
  return hole.from === hole.to ? `${hole.from}` : `${hole.from}-${hole.to}`
}

function describeRanges(ranges: readonly SessionSequenceRange[] | undefined): string {
  if (ranges === undefined) return 'none'
  return ranges.length === 0 ? 'empty' : ranges.map((range) => `${range.from}-${range.to}`).join(',')
}
