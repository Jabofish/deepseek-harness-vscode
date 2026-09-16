import { describe, expect, it } from 'vitest'

import type { SessionRepository } from '../../packages/domain/src/backend.js'
import type { SessionHistoryEvent } from '../../packages/domain/src/sessions.js'
import type { ChangeDiff } from '../../packages/domain/src/changes.js'
import { ChangeSetTracker } from '../../apps/extension/src/changes/change-set-tracker.js'
import { publicWorkspaceRelativePath } from '../../apps/extension/src/view/public-value.js'

import { LIVE_TIMEOUT_MS, canConnect, startManagedRuntime } from './harness.js'

/** History pages read per registry row while looking for hunk-bearing rows. */
const MAX_PAGES = 3
/** Registry rows scanned at most; the scan stops once a multi-hunk row is in hand. */
const SESSION_SCAN_LIMIT = 80

/**
 * Live change-review evidence: every hunk the host really sent for one file
 * survives into the change row.
 *
 * The pinned host computes one diff per applied hunk (`computeHunkDiffs`, three
 * context lines each), so a scattered edit arrives as a whole list and the
 * change review has to keep all of it — the row's status, its line totals and
 * its detail text are all statements about the whole list. It also states those
 * hunks under the file's absolute host path, which only the Host can fit to a
 * workspace-relative one. The unit specs pin both against hand-written
 * payloads; this spec pins them against the payloads a real runtime persisted,
 * and asserts the `change.diffs.length === presentation.diffs.length` invariant
 * that a last-hunk-wins index silently broke.
 *
 *   $env:DSH_LIVE_SMOKE = '1'
 *   npx vitest run tests/live-dsh/change-hunks.spec.ts
 *
 * Read-only: it starts the managed runtime, reads history and stops the process
 * it started. It never sends a prompt, never writes to the runtime, and never
 * touches an external DSH.
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live change-review hunks', () => {
  it(
    'keeps every hunk a real settled mutation row carried',
    async () => {
      const runtime = await startManagedRuntime()
      try {
        const sessions = await runtime.backend.sessions.list()
        expect(sessions.items.length, 'the live runtime must expose at least one session').toBeGreaterThan(0)

        const candidates: SettledMutation[] = []
        let scanned = 0
        for (const candidate of sessions.items.slice(0, SESSION_SCAN_LIMIT)) {
          scanned += 1
          const sessionRows = await collectHistory(runtime.backend.sessions, candidate.id, MAX_PAGES)
          candidates.push(
            ...sessionRows.flatMap((row) => settledMutationHunks(candidate.id, row, candidate.cwd)),
          )
          if (candidates.some((entry) => entry.hunks.length > 1) && candidates.length >= 3) break
        }
        const multiHunkRows = candidates.filter((entry) => entry.hunks.length > 1).length
        const hostAbsoluteRows = candidates.filter((entry) => entry.hostPath !== undefined).length
        console.log(
          `[dsh-live-change-hunks] scanned=${scanned} settled-mutation-rows=${candidates.length} multi-hunk-rows=${multiHunkRows} host-absolute-rows=${hostAbsoluteRows}`,
        )
        expect(
          candidates.length,
          `no settled mutation row found in ${scanned} registry rows; the hunk invariants would be vacuous`,
        ).toBeGreaterThan(0)

        for (const { sessionId, cwd, tool, relativePath, hunks } of candidates) {
          // One row into a fresh tracker: the invariant is about what this row
          // states, not about how several calls to one path merge. The path
          // fitter mirrors the composition root's: the host's absolute path is
          // fitted against the workspace folder that owns the session.
          const tracker = new ChangeSetTracker({
            now: () => 1_000,
            toWorkspaceRelativePath: (_workspaceFolderId, hostPath) => fitWorkspacePath(hostPath, cwd),
          })
          await tracker.observeNow({
            sessionId,
            workspaceFolderId: 'workspace-1',
            identity: {
              backendInstanceId: 'live',
              connectionGeneration: 1,
              stream: 'mux',
              sessionId,
              serverSeq: 0,
              toolCallId: tool.id,
            },
            tool,
            observedAt: 1_000,
          })
          const changes = await tracker.list({ sessionId })
          const change = changes.find((entry) => entry.relativePath === relativePath)

          expect(change, `${tool.name} must appear in the review under ${relativePath}`).toBeDefined()
          expect(change?.diffs, `${tool.name} must keep every hunk it sent for ${relativePath}`).toEqual(
            hunks,
          )
          expect(change?.diffAvailable).toBe(true)
          expect(change?.status, `${tool.name} status must follow the whole hunk list`).toBe(
            statusForHunks(hunks),
          )
          expect(change?.additions).toBe(hunks.reduce((sum, hunk) => sum + lines(hunk.newText), 0))
          expect(change?.deletions).toBe(hunks.reduce((sum, hunk) => sum + lines(hunk.oldText), 0))

          const detail = await tracker.get(change!.changeId)
          // The detail draws every hunk and one `⋯` between two of them, so a
          // reader of a scattered edit sees all of it rather than its tail.
          expect(detail.redactedDiff?.split('\n')).toHaveLength(
            hunks.reduce((sum, hunk) => sum + lines(hunk.oldText) + lines(hunk.newText), 0) +
              hunks.length -
              1,
          )
          if (hunks.length > 1) expect(detail.redactedDiff).toContain('⋯')
        }
      } finally {
        await runtime.stop()
        const released = !(await canConnect(runtime.snapshot.port))
        console.log(
          `[dsh-live-change-hunks] managed stop port ${runtime.snapshot.port} released=${String(released)}`,
        )
        expect(released, `loopback port ${runtime.snapshot.port} must be released`).toBe(true)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})

/**
 * The hunks of one settled mutation row that really carry a diff card, straight
 * from the row's own presentation — the same list the change row has to keep.
 * One entry per file, because a change row is per path, and the file is named by
 * the path the Host fits it to. A running or failed row states no applied change
 * here, and neither does a row whose file lies outside the session workspace.
 */
function settledMutationHunks(
  sessionId: string,
  row: SessionHistoryEvent,
  cwd: string | undefined,
): readonly SettledMutation[] {
  if (row.event.type !== 'tool.updated') return []
  const tool = row.event.tool
  if (tool.status !== 'completed') return []
  const view = tool.presentation
  if (view?.card !== 'diff' || view.phase !== 'result') return []
  const byPath = new Map<string, { hunks: ChangeDiff[]; hostPath: string | undefined }>()
  for (const diff of view.diffs) {
    const relativePath = fitWorkspacePath(diff.path, cwd)
    if (relativePath === undefined) continue
    const entry = byPath.get(relativePath)
    const hunk = { oldText: diff.oldText, newText: diff.newText }
    const hostPath = relativePath === diff.path ? undefined : diff.path
    if (entry === undefined) byPath.set(relativePath, { hunks: [hunk], hostPath })
    else entry.hunks.push(hunk)
  }
  return [...byPath].map(([relativePath, entry]) => ({
    sessionId,
    cwd,
    tool,
    relativePath,
    hostPath: entry.hostPath,
    hunks: entry.hunks,
  }))
}

/** The composition root's fitting rule: resolve the host path against the owned workspace root. */
function fitWorkspacePath(hostPath: string, cwd: string | undefined): string | undefined {
  return cwd === undefined ? undefined : publicWorkspaceRelativePath(hostPath, cwd, [cwd])
}

interface SettledMutation {
  readonly sessionId: string
  readonly cwd: string | undefined
  readonly tool: ToolRow
  readonly relativePath: string
  /** The raw host path, when the row stated one; `undefined` for a relative row. */
  readonly hostPath: string | undefined
  readonly hunks: readonly ChangeDiff[]
}

type ToolRow = Extract<SessionHistoryEvent['event'], { readonly type: 'tool.updated' }>['tool']

/** The status the whole hunk list states: no old side at all is a create, no new side a deletion. */
function statusForHunks(hunks: readonly ChangeDiff[]): string {
  if (hunks.every((hunk) => hunk.oldText === null)) return 'added'
  if (hunks.every((hunk) => hunk.newText.length === 0)) return 'deleted'
  return 'modified'
}

/** The reference card's line rule: an empty side is no lines, one trailing newline is a terminator. */
function lines(text: string | null): number {
  if (text === null || text.length === 0) return 0
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n').length
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
