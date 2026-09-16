import { describe, expect, it } from 'vitest'

import type { AppError } from '../../packages/domain/src/errors.js'
import type { SessionDetail, SessionHistoryEvent } from '../../packages/domain/src/sessions.js'
import { LIVE_TIMEOUT_MS, canConnect, startManagedRuntime } from './harness.js'

/** How many membership-only Sessions one run may probe with a detail read. */
const MEMBERS_ONLY_PROBE_LIMIT = 5

/** How many real Sessions one run may read; each `get` is one history page. */
const SAMPLE_LIMIT = 12

/**
 * Upstream records the adapter keeps as opaque unknowns on purpose: they write
 * trajectory/inbox state and carry no human transcript surface
 * (`docs/dsh-contract.md`, "传输与事件边界"). A name outside this set that this
 * build cannot read is a new host vocabulary entry to classify, not noise.
 */
const DOCUMENTED_OPAQUE_ROWS = new Set([
  'agent/inbox/spliced',
  'image/offload',
  'session/end-seed',
  'session/title-llm-request',
  'web/deepseek-search-llm-request',
])

/**
 * Cross-path consistency over real profile data. `session.list` is read last on
 * purpose: a client with a cold cache — a fresh Webview, or the task center
 * asking for a Session nobody listed yet — builds `session.get` from the
 * durable history alone. That derivation and the host's own list row describe
 * the same Session and must not contradict each other.
 *
 *   $env:DSH_LIVE_SMOKE = '1'
 *   $env:DSH_LIVE_RUNTIME_VERSION = '0.1.6-alpha.1'
 *   npx vitest run tests/live-dsh/consistency.spec.ts
 *
 * Nothing is mutated: the profile is only read. Only the process started here
 * is signalled; an external DSH is never touched.
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live DSH session read-path consistency', () => {
  it(
    'derives the same Session facts from a cold-cache detail read and the host list row',
    async () => {
      const runtime = await startManagedRuntime()
      const evidence: string[] = []
      const divergences: string[] = []
      let released: boolean | undefined
      try {
        const { backend } = runtime
        const unsubscribe = backend.events.subscribe(() => undefined)
        try {
          const [workspaces, archived] = await Promise.all([
            backend.workspaces.list(),
            backend.workspaces.listArchivedSessionIds(),
          ])
          const archivedIds = new Set(archived)
          // Workspace membership is readable without warming the Session list,
          // which is what keeps every detail below on the fallback path.
          const membership = [
            ...new Set(workspaces.flatMap((workspace) => workspace.sessionIds ?? [])),
          ].filter((sessionId) => !archivedIds.has(sessionId))
          const sampled = membership.slice(0, SAMPLE_LIMIT)
          if (sampled.length === 0) throw new Error('the profile has no workspace Session to sample')

          const details = new Map<string, SessionDetail>()
          for (const sessionId of sampled) details.set(sessionId, await backend.sessions.get(sessionId))

          const page = await backend.sessions.list()
          const rows = new Map(page.items.map((item) => [item.id, item] as const))
          evidence.push(`list rows=${page.items.length} nextCursor=${String(page.nextCursor !== undefined)}`)
          // The switcher reads this one page and the adapter refuses a cursor,
          // so a host that paginated would silently drop conversations.
          if (page.nextCursor !== undefined)
            divergences.push(
              `the host list is paginated (${page.items.length} rows in the first page) while the ` +
                'client cannot follow a cursor',
            )
          // The switcher reads `session.list`; membership that the list omits is
          // reachable only by id. A Session that answers its own detail read is
          // not a subagent child, so nothing else can surface it.
          const membersOnly = membership.filter((sessionId) => !rows.has(sessionId))
          if (membersOnly.length > 0)
            evidence.push(
              `workspace membership holds ${membersOnly.length} Session(s) the list omits: ` +
                `${membersOnly.slice(0, MEMBERS_ONLY_PROBE_LIMIT).join(' ')}`,
            )
          for (const sessionId of membersOnly.slice(0, MEMBERS_ONLY_PROBE_LIMIT)) {
            try {
              const detail = await backend.sessions.get(sessionId)
              evidence.push(
                `workspace-only ${sessionId} detail blank=${String(detail.blank)} status=${detail.status} ` +
                  `title=${JSON.stringify(detail.title)} history=${(detail.history ?? []).length}`,
              )
              divergences.push(
                `${sessionId} belongs to a workspace and reads as a Session, but the host list omits it`,
              )
            } catch (error) {
              // A child Session refuses a session-kind address; that is why it
              // is absent from the list and hidden from the switcher.
              evidence.push(
                `workspace-only ${sessionId} detail unavailable ` +
                  `code=${(error as Partial<AppError>).code ?? 'unknown'}`,
              )
            }
          }
          const titled = [...details.values()].find(
            (detail) => detail.blank === false && detail.title.trim() !== '',
          )
          if (titled === undefined) evidence.push('no titled Session to search for')
          else {
            // A deployment may disable its session-query index; the drawer
            // reports that refusal as "content search unavailable" instead of
            // "no matches", so a refusal is evidence and an answer is compared
            // against the Session whose own title carries the token.
            const token = [...titled.title.trim()].slice(0, 12).join('')
            try {
              const found = await backend.sessions.list({ search: token, archived: false })
              const hit = found.items.some((item) => item.id === titled.id)
              evidence.push(
                `search ${JSON.stringify(token)} rows=${found.items.length} hitsItsOwnTitle=${String(hit)}`,
              )
              if (rows.has(titled.id) && !hit)
                divergences.push(
                  `searching ${JSON.stringify(token)} misses ${titled.id}, whose own title is ` +
                    `${JSON.stringify(titled.title)}`,
                )
              const never = `no-such-token-${Date.now().toString(36)}`
              const empty = await backend.sessions.list({ search: never, archived: false })
              if (empty.items.length !== 0)
                divergences.push(`the unmatchable query ${never} returned ${empty.items.length} row(s)`)
            } catch (error) {
              const failure = error as Partial<AppError>
              evidence.push(
                `search ${JSON.stringify(token)} refused code=${failure.code ?? 'unknown'} ` +
                  `rpcCode=${failure.context?.rpcCode ?? 'unknown'}`,
              )
            }
          }

          let compared = 0
          let complete = 0
          for (const sessionId of sampled) {
            const detail = details.get(sessionId)
            const row = rows.get(sessionId)
            if (detail === undefined) continue
            const history = detail.history ?? []
            const unreadable = history.filter((entry) => entry.event.type === 'unknown')
            for (const entry of unreadable) {
              const name = entry.event.type === 'unknown' ? entry.event.name : ''
              if (!DOCUMENTED_OPAQUE_ROWS.has(name))
                divergences.push(`${sessionId}: unclassified unreadable row ${name}`)
            }
            if (row === undefined) {
              evidence.push(
                `${sessionId} row=absent detail blank=${String(detail.blank)} status=${detail.status}`,
              )
              continue
            }
            compared += 1
            const kinds = [...new Set(history.map((entry) => entry.event.type))].sort()
            evidence.push(
              `${sessionId} row(blank=${String(row.blank)} status=${row.status} title=${JSON.stringify(row.title)}) ` +
                `detail(blank=${String(detail.blank)} status=${detail.status} title=${JSON.stringify(detail.title)}) ` +
                `history=${history.length} hasMore=${String(detail.historyHasMore === true)} ` +
                `unreadable=${unreadable.length} ${unreadableNames(unreadable)} kinds=${kinds.join('|')}`,
            )
            if (detail.blank && detail.status !== 'idle')
              divergences.push(`${sessionId}: a blank detail must read idle, got ${detail.status}`)
            // A page with more history behind it cannot prove the Session has no
            // human turn: the oldest rows are the ones holding it. Only a
            // complete read is compared exactly.
            if (detail.historyHasMore === true) {
              if (row.blank !== detail.blank)
                evidence.push(`${sessionId}: partial page reads blank=${String(detail.blank)}`)
            } else {
              complete += 1
              if (row.blank === false && detail.blank === true)
                divergences.push(`${sessionId}: the complete history has content but reads blank`)
              if (row.title !== detail.title && row.blank === false)
                divergences.push(
                  `${sessionId}: the complete history titles the Session ${JSON.stringify(detail.title)} ` +
                    `where the host row says ${JSON.stringify(row.title)}`,
                )
            }
          }
          evidence.push(
            `compared ${compared} of ${sampled.length} sampled Session(s), ${complete} with a complete history`,
          )
          expect(divergences, 'the durable-history derivation must not contradict the host list row').toEqual(
            [],
          )
          expect(compared, 'at least one sampled Session must have a host list row').toBeGreaterThan(0)
        } finally {
          unsubscribe()
        }
      } finally {
        await runtime.stop()
        released = !(await canConnect(runtime.snapshot.port))
        for (const step of runtime.steps) console.log(`[dsh-live-consistency] ${step}`)
        for (const line of evidence) console.log(`[dsh-live-consistency] ${line}`)
        for (const line of divergences) console.log(`[dsh-live-consistency] DIVERGENCE ${line}`)
        console.log(
          `[dsh-live-consistency] managed stop port ${runtime.snapshot.port} released=${String(released)}`,
        )
        expect(released, `loopback port ${runtime.snapshot.port} must be released`).toBe(true)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})

/** `unreadable=2 (session/end-seed×2)`: which host rows this build cannot read. */
function unreadableNames(unreadable: readonly SessionHistoryEvent[]): string {
  const counts = new Map<string, number>()
  for (const entry of unreadable) {
    const name = entry.event.type === 'unknown' ? entry.event.name : entry.event.type
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return `(${[...counts].map(([name, count]) => `${name}×${count}`).join(' ')}${counts.size === 0 ? '—' : ''})`
}
