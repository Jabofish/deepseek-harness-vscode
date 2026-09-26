import { describe, expect, it } from 'vitest'

import type { SessionRepository } from '../../packages/domain/src/backend.js'
import type { SessionHistoryEvent } from '../../packages/domain/src/sessions.js'
import type { ToolCallView } from '../../packages/domain/src/tools.js'
import { reduceTimelineBatch, type TimelineState } from '../../packages/timeline/src/index.js'

import {
  hasLiveHistoryFixture,
  LIVE_TIMEOUT_MS,
  canConnect,
  requireLiveHistoryFixtureHome,
  startManagedRuntime,
} from './harness.js'

/** History pages read per registry row while looking for card-bearing sessions. */
const MAX_PAGES = 3
/** Registry rows scanned at most; the scan stops early once both kinds are covered. */
const SESSION_SCAN_LIMIT = 80

/**
 * Live tool-card evidence: the cards this build derives for the first-party
 * shell and file-mutation tools, checked against the real rows of a real
 * runtime.
 *
 * The pinned host persists no per-tool view on either `tool/call` or
 * `tool/result`, so every card is derived client-side: the running card from a
 * call's own arguments and the settled card where the call and its result meet
 * in the timeline. The transcript spec's conservation checks cannot see those
 * cards — its sampled registry rows may carry none of these tools at all, which
 * is exactly how this evidence went vacuous once. This spec therefore scans the
 * registry for sessions that really hold a first-party shell or mutation call
 * and asserts the invariants on those rows, so a card that disagrees with the
 * arguments or the output it restates fails here.
 *
 *   $env:DSH_LIVE_SMOKE = '1'
 *   npx vitest run tests/live-dsh/tool-cards.spec.ts
 *
 * It never sends a prompt or a DSH write request; startup state stays in the
 * disposable history fixture. It needs a fixture whose events hold at least
 * one shell or mutation call;
 * without one the invariants would be vacuous, so that is a failure rather than
 * a pass.
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1' || !hasLiveHistoryFixture())('live DSH tool cards', () => {
  it(
    'states each first-party tool card from the row it was derived from',
    async () => {
      const runtime = await startManagedRuntime({ dshHome: requireLiveHistoryFixtureHome() })
      try {
        const sessions = await runtime.backend.sessions.list()
        expect(sessions.items.length, 'the live runtime must expose at least one session').toBeGreaterThan(0)

        // Collect the rows of every registry row that really holds a call the
        // invariants can check. A session is kept only when it contributes at
        // least one candidate — a call whose own arguments state a command or a
        // change, or a reduced row a call card settled into — so a session that
        // merely mentions these tools (a failed `bash`, a `str_replace_editor`
        // `view`) cannot satisfy the scan and leave the checks empty. The scan
        // stops once every kind of evidence is in hand.
        const sampled: SessionHistoryEvent[][] = []
        const reducedSamples: TimelineState[] = []
        let scanned = 0
        let runningShells = 0
        let settledShells = 0
        let mutations = 0
        for (const candidate of sessions.items.slice(0, SESSION_SCAN_LIMIT)) {
          scanned += 1
          const rows = await collectHistory(runtime.backend.sessions, candidate.id, MAX_PAGES)
          const reduced = reduceTimelineBatch(
            { sessionId: candidate.id, nodes: [], lastSequence: Number.MIN_SAFE_INTEGER },
            rows.map(({ event, sequence }) => ({ event, sequence, advanceSequence: false })),
          )
          const kind = candidateKinds(rows, reduced)
          if (kind.total === 0) continue
          sampled.push([...rows])
          reducedSamples.push(reduced)
          runningShells += kind.runningShells
          settledShells += kind.settledShells
          mutations += kind.mutations
          if (runningShells > 0 && settledShells > 0 && mutations > 0) break
        }
        console.log(
          `[dsh-live-cards] sessions=${sessions.items.length} scanned=${scanned} sampled=${sampled.length} shells=${runningShells}+${settledShells} mutations=${mutations}`,
        )

        // --- Running mutations: a real write/edit call must state its own change.
        // The running card is derived from the call's own arguments, so a real
        // row has to restate exactly the file and text its arguments hold — a
        // card that disagreed would put a wrong path or wrong content in front
        // of a reader reviewing a change before it is applied.
        const mutationCalls = sampled.flatMap((rows) =>
          rows.flatMap((row) => {
            if (row.event.type !== 'tool.updated') return []
            const tool = row.event.tool
            if (tool.status !== 'running' || tool.parentCallId !== undefined) return []
            const stated = statedMutation(tool.name, tool.inputSummary)
            return stated === undefined ? [] : [{ tool, stated }]
          }),
        )
        const missingIntent = mutationCalls.filter(
          (entry) => entry.tool.presentation?.phase !== 'call' || entry.tool.presentation.card !== 'diff',
        )
        console.log(
          `[dsh-live-cards] running-mutation-cards=${mutationCalls.length - missingIntent.length}/${mutationCalls.length}`,
        )
        expect(
          missingIntent.map((entry) => entry.tool.name),
          'a running first-party file mutation must carry the change its arguments state',
        ).toEqual([])
        for (const { tool, stated } of mutationCalls) {
          const view = tool.presentation
          if (view?.phase !== 'call' || view.card !== 'diff') continue
          expect(view.diffs, `running ${tool.name} must state one file`).toEqual([stated])
        }

        // --- Running commands: a real foreground shell call must state its own
        // command, which is also what an approval paired with the call shows a
        // user deciding on. A card that disagreed, or none at all, is a command
        // nobody can read before or while it runs.
        const shellCalls = sampled.flatMap((rows) =>
          rows.flatMap((row) => {
            if (row.event.type !== 'tool.updated') return []
            const tool = row.event.tool
            if (tool.status !== 'running') return []
            const command = statedCommand(tool.name, tool.inputSummary)
            return command === undefined ? [] : [{ tool, command }]
          }),
        )
        const missingCommand = shellCalls.filter(
          (entry) => entry.tool.presentation?.phase !== 'call' || entry.tool.presentation.card !== 'terminal',
        )
        console.log(
          `[dsh-live-cards] running-command-cards=${shellCalls.length - missingCommand.length}/${shellCalls.length}`,
        )
        expect(
          missingCommand.map((entry) => entry.tool.name),
          'a running first-party shell call must state the command its arguments carry',
        ).toEqual([])
        for (const { tool, command } of shellCalls) {
          const view = tool.presentation
          if (view?.phase !== 'call' || view.card !== 'terminal') continue
          expect(view.title, `running ${tool.name} must state the command it runs`).toBe(command)
        }

        // --- Settled commands: a finished shell call must show what it printed.
        // A durable `tool/result` frame carries no name and no arguments, so the
        // call and its result meet only in the reduced row: the card a running
        // call stated has to be settled into the card its own output states. A
        // row that keeps its running card hides every byte the command produced
        // and reports a failed command as a command with no result, so this
        // reads the exit status back out of the raw output and requires the row
        // to repeat it.
        const callCardIds = new Set(
          sampled.flatMap((rows) =>
            rows.flatMap((row) =>
              row.event.type === 'tool.updated' &&
              row.event.tool.presentation?.phase === 'call' &&
              row.event.tool.presentation.card === 'terminal'
                ? [row.event.tool.id]
                : [],
            ),
          ),
        )
        const hostStatedResultIds = new Set(
          sampled.flatMap((rows) =>
            rows.flatMap((row) =>
              row.event.type === 'tool.updated' && row.event.tool.presentation?.phase === 'result'
                ? [row.event.tool.id]
                : [],
            ),
          ),
        )
        const settledShellRows = reducedSamples.flatMap((state) =>
          state.nodes.flatMap((node) => {
            if (node.kind !== 'tool' || !callCardIds.has(node.id)) return []
            const text = settledShellText(node.tool)
            return text === undefined ? [] : [{ tool: node.tool, text }]
          }),
        )
        const unsettled = settledShellRows.filter(
          (entry) =>
            entry.tool.presentation?.phase !== 'result' || entry.tool.presentation.card !== 'terminal',
        )
        console.log(
          `[dsh-live-cards] settled-command-cards=${settledShellRows.length - unsettled.length}/${settledShellRows.length}`,
        )
        expect(
          unsettled.map((entry) => entry.tool.name),
          'a settled first-party shell row must state the output its result carries',
        ).toEqual([])
        for (const { tool, text } of settledShellRows) {
          const view = tool.presentation
          if (view?.phase !== 'result' || view.card !== 'terminal') continue
          const expected = shellExitStatus(text)
          expect(
            view.signal ?? view.exitCode,
            `settled ${tool.name} must state the exit status its own output ends with`,
          ).toBe(expected.signal ?? expected.exitCode)
          expect(view.output ?? '', `settled ${tool.name} must state the output it printed`).toBe(
            expected.output,
          )
          // A settled row has no command to authorize; only a card the host
          // stated itself may keep a title here.
          if (!hostStatedResultIds.has(tool.id)) expect(view.title).toBeUndefined()
        }

        // --- Settled mutations: an applied change is the only diff a settled
        // row may claim, and every entry it shows must name the file its own
        // arguments name. A failed or cancelled call must not present applied
        // diffs at all: the host settles a failing mutation as an errored result
        // whose `meta` is absent, and a card that claimed applied hunks anyway
        // would show a change the file never received. The host states one diff
        // per applied hunk, so a settled card of one file legitimately carries
        // several entries under that one path.
        const settledMutations = reducedSamples.flatMap((state) =>
          state.nodes.flatMap((node) => {
            if (node.kind !== 'tool' || node.tool.status === 'running') return []
            const tool = node.tool
            if (tool.parentCallId !== undefined) return []
            const stated = statedMutation(tool.name, tool.inputSummary)
            return stated === undefined ? [] : [{ tool, stated }]
          }),
        )
        const appliedClaims = settledMutations.filter(
          (entry) => entry.tool.status !== 'completed' && entry.tool.presentation?.phase === 'result',
        )
        console.log(
          `[dsh-live-cards] settled-mutations=${settledMutations.length} applied-claims-without-completion=${appliedClaims.length}`,
        )
        expect(
          appliedClaims.map((entry) => entry.tool.name),
          'a mutation that did not complete must not present applied diffs',
        ).toEqual([])
        let settledMultiHunkFiles = 0
        for (const { tool, stated } of settledMutations) {
          const view = tool.presentation
          // A settled row keeps either the applied result card or the
          // call-phase intent card (the change list reads the attempt from it);
          // either way the change it shows must be the change the row states.
          if (view?.card !== 'diff') continue
          if (view.phase === 'call') {
            expect(view.diffs, `intent card of settled ${tool.name} must restate its arguments`).toEqual([
              stated,
            ])
            continue
          }
          expect(view.diffs.length, `settled ${tool.name} must state the change it applied`).toBeGreaterThan(
            0,
          )
          expect(
            [...new Set(view.diffs.map((diff) => diff.path))].map((path) => sameFilePath(path, stated.path)),
            `settled ${tool.name} must state the file its own arguments name`,
          ).toEqual([true])
          if (view.diffs.length > 1) settledMultiHunkFiles += 1
        }
        console.log(`[dsh-live-cards] settled-multi-hunk-result-cards=${settledMultiHunkFiles}`)

        // The invariants above only mean something if real rows reached them.
        expect(
          mutationCalls.length + shellCalls.length + settledShellRows.length + settledMutations.length,
          `no first-party tool call found in ${scanned} registry rows; the card invariants would be vacuous`,
        ).toBeGreaterThan(0)
      } finally {
        await runtime.stop()
        const released = !(await canConnect(runtime.snapshot.port))
        console.log(
          `[dsh-live-cards] managed stop port ${runtime.snapshot.port} released=${String(released)}`,
        )
        expect(released, `loopback port ${runtime.snapshot.port} must be released`).toBe(true)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})

/**
 * How many rows of one session the invariants can actually check: a running
 * shell call whose arguments state a command, a reduced row a shell call card
 * settled into, and a mutation the row's own arguments state. A row that only
 * carries one of these tool names is not evidence.
 */
function candidateKinds(
  rows: readonly SessionHistoryEvent[],
  reduced: TimelineState,
): {
  readonly runningShells: number
  readonly settledShells: number
  readonly mutations: number
  readonly total: number
} {
  const callCardIds = new Set(
    rows.flatMap((row) =>
      row.event.type === 'tool.updated' &&
      row.event.tool.presentation?.phase === 'call' &&
      row.event.tool.presentation.card === 'terminal'
        ? [row.event.tool.id]
        : [],
    ),
  )
  let runningShells = 0
  let mutations = 0
  for (const row of rows) {
    if (row.event.type !== 'tool.updated') continue
    const tool = row.event.tool
    if (tool.status !== 'running' || tool.parentCallId !== undefined) continue
    if (statedCommand(tool.name, tool.inputSummary) !== undefined) runningShells += 1
    else if (statedMutation(tool.name, tool.inputSummary) !== undefined) mutations += 1
  }
  let settledShells = 0
  for (const node of reduced.nodes) {
    if (node.kind !== 'tool') continue
    if (callCardIds.has(node.id) && settledShellText(node.tool) !== undefined) settledShells += 1
    if (
      node.tool.status !== 'running' &&
      statedMutation(node.tool.name, node.tool.inputSummary) !== undefined
    )
      mutations += 1
  }
  return { runningShells, settledShells, mutations, total: runningShells + settledShells + mutations }
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

/**
 * The change a durable call row's own arguments state, read straight from the
 * raw payload the row kept — the same statement its call-phase card has to
 * repeat. A row whose arguments state no first-party mutation has no running
 * card to check, so this returns undefined for it.
 */
function statedMutation(
  name: string,
  inputSummary: string | undefined,
): { readonly path: string; readonly oldText: string | null; readonly newText: string } | undefined {
  if (inputSummary === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(inputSummary)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const args = parsed as Record<string, unknown>
  const tool = name.trim().toLocaleLowerCase()
  if (tool === 'str_replace_editor') {
    const path = typeof args.path === 'string' && args.path.trim() !== '' ? args.path : undefined
    if (path === undefined) return undefined
    if (args.command === 'create') {
      if (args.file_text !== undefined && typeof args.file_text !== 'string') return undefined
      return { path, oldText: null, newText: typeof args.file_text === 'string' ? args.file_text : '' }
    }
    if (args.command !== 'str_replace') return undefined
    if (args.old_str !== undefined && typeof args.old_str !== 'string') return undefined
    if (args.new_str !== undefined && typeof args.new_str !== 'string') return undefined
    return {
      path,
      oldText: typeof args.old_str === 'string' ? args.old_str : null,
      newText: typeof args.new_str === 'string' ? args.new_str : '',
    }
  }
  if (tool !== 'write' && tool !== 'edit') return undefined
  const path = typeof args.file_path === 'string' && args.file_path.trim() !== '' ? args.file_path : undefined
  if (path === undefined || !validEscalation(args)) return undefined
  if (tool === 'write')
    return typeof args.content === 'string' ? { path, oldText: null, newText: args.content } : undefined
  if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') return undefined
  if (args.replace_all !== undefined && typeof args.replace_all !== 'boolean') return undefined
  return { path, oldText: args.old_string === '' ? null : args.old_string, newText: args.new_string }
}

/**
 * The command a durable shell call row's own arguments state, read straight
 * from the raw payload the row kept — the same statement its call-phase card
 * has to repeat. A background call, a non-shell tool and a row whose arguments
 * state no readable command have no running card to check, so this returns
 * undefined for them.
 */
function statedCommand(name: string, inputSummary: string | undefined): string | undefined {
  if (inputSummary === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(inputSummary)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const args = parsed as Record<string, unknown>
  const tool = name.trim().toLocaleLowerCase()
  if (tool === 'bash' || tool === 'pwsh') {
    if (typeof args.command !== 'string' || args.command.trim() === '') return undefined
    if (args.run_in_background !== undefined) return undefined
    return args.command
  }
  if (tool !== 'terminal_send') return undefined
  if (typeof args.sessionId !== 'string' || args.sessionId === '') return undefined
  if (typeof args.text !== 'string' || args.text.trim() === '') return undefined
  if (args.run_in_background !== undefined) return undefined
  return args.text
}

/**
 * The settled output text of a shell row, or undefined when the row has no
 * settled terminal card to check: a call whose arguments do not state a
 * foreground one-shot command (a background call, a persistent shell that omits
 * its description, a malformed flag), a row that failed, and a result whose
 * preview was spilled (its footer can hide the exit marker) all fall back to
 * the generic row instead.
 */
function settledShellText(tool: ToolCallView): string | undefined {
  if (tool.status !== 'completed' || tool.error !== undefined) return undefined
  const name = tool.name.trim().toLocaleLowerCase()
  if (name !== 'bash' && name !== 'pwsh') return undefined
  const output = tool.outputSummary
  if (output === undefined || output === '') return undefined
  // The spill footer is the host's own rendering policy literal, not this
  // build's: a preview that ends with one is not the command's whole text.
  if (output.includes('Full formatted result stored at: ')) return undefined
  if (tool.inputSummary === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(tool.inputSummary)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const args = parsed as Record<string, unknown>
  if (typeof args.command !== 'string' || args.command.trim() === '') return undefined
  // A persistent shell omits the description the standard tool always states.
  if (typeof args.description !== 'string' || args.description.trim() === '') return undefined
  if (args.run_in_background === true) return undefined
  return output
}

/**
 * The exit status the pinned shell renderer writes into its own output. The
 * marker literals are the renderer's contract, restated here verbatim rather
 * than read from the build under test; the signal marker wins, and output with
 * no marker at all is a command that exited zero, since the renderer appends a
 * marker only for a non-zero code.
 */
function shellExitStatus(text: string): { output: string; exitCode?: number; signal?: string } {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/u.exec(text)
  if (signal?.[1] !== undefined) return { output: text.slice(0, signal.index), signal: signal[1] }
  const exit = /\n\[exit code: (\d+)\]$/u.exec(text)
  if (exit?.[1] !== undefined) return { output: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  return { output: text, exitCode: 0 }
}

/** The optional escalation pair a file mutation may declare, valid or not. */
function validEscalation(args: Record<string, unknown>): boolean {
  const permission = args.sandbox_permissions
  const justification = args.justification
  if (permission === undefined && justification === undefined) return true
  if (permission !== 'workspace-write' && permission !== 'danger-full-access') return false
  return typeof justification === 'string' && justification.trim() !== ''
}

/**
 * Whether two paths a row stated name the same file. The call arguments carry
 * the path as the model wrote it while the applied `meta` carries the path the
 * tool resolved, so one file can arrive under two separator styles or two
 * cases; what the row claims is that both name the same file, not that they are
 * spelled identically.
 */
function sameFilePath(left: string, right: string): boolean {
  if (left.trim() === '' || right.trim() === '') return false
  const normalize = (value: string): string => {
    const separators = value.trim().replaceAll('\\', '/')
    return /^[A-Za-z]:/u.test(separators) ? separators.toLowerCase() : separators
  }
  return normalize(left) === normalize(right)
}
