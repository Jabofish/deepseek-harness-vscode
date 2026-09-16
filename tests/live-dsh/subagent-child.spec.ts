import { describe, expect, it } from 'vitest'

import type { DshBackend } from '../../packages/domain/src/backend.js'
import { LIVE_TIMEOUT_MS, startManagedRuntime } from './harness.js'

interface ChildSample {
  readonly childId: string
  readonly parentId: string
  readonly mode: 'one-shot' | 'continuable'
}

/**
 * A child Session is only reachable through the durable descriptor its parent
 * catalog publishes: the Session Controller refuses a session-kind address for
 * a subagent-origin Session ("use subagent delivery for this child session"),
 * on `session/follow` and `session/history` alike.
 *
 * A child only exists once someone delegates from the DSH UI, and this suite
 * must not create one in the developer's own profile, so the spec samples every
 * listed session's catalog and records that the child leg was not reachable
 * when the profile holds none. The catalog reads themselves are always
 * asserted against the real host.
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live subagent child addressing', () => {
  it(
    'reads a catalog-published child through its durable subagent address',
    async () => {
      const runtime = await startManagedRuntime()
      const { backend } = runtime
      // The Extension Host subscribes on connect; keep the same session/follow
      // stream open for the whole read instead of querying an idle backend.
      const unsubscribe = backend.events.subscribe(() => undefined)
      try {
        const sessions = await backend.sessions.list()
        const scan = await scanForChild(
          backend,
          sessions.items.map((item) => item.id),
        )
        runtime.steps.push(
          `subagent catalogs answered=${scan.answered} scanned=${scan.scanned} child=${scan.child === undefined ? 'none' : scan.child.childId}`,
        )
        if (sessions.items.length > 0) expect(scan.answered).toBeGreaterThan(0)

        if (scan.child === undefined) {
          console.log(
            '[live subagent child] no catalog-published child in this profile; child leg not sampled',
          )
          return
        }
        const { childId, parentId } = scan.child
        // The ownership walk the Extension Host runs for every child-scoped
        // route depends on this durable parent link.
        expect(backend.subagents.parentOf?.(childId)).toBe(parentId)

        const detail = await backend.sessions.get(childId)
        expect(detail.id).toBe(childId)
        const page = await backend.subagents.history?.(childId)
        expect(page?.events).toBeDefined()
      } finally {
        unsubscribe()
        await runtime.stop()
      }
    },
    LIVE_TIMEOUT_MS * 2,
  )
})

async function scanForChild(
  backend: DshBackend,
  sessionIds: readonly string[],
): Promise<{ readonly answered: number; readonly scanned: number; readonly child?: ChildSample }> {
  let answered = 0
  let scanned = 0
  for (const parentId of sessionIds.slice(0, 60)) {
    scanned += 1
    let entries: Awaited<ReturnType<DshBackend['subagents']['list']>>['entries']
    try {
      entries = (await backend.subagents.list(parentId)).entries
    } catch {
      continue
    }
    answered += 1
    const entry = entries.find((candidate) => candidate.kind === 'child')
    if (entry !== undefined)
      return { answered, scanned, child: { childId: entry.id, parentId, mode: entry.mode } }
  }
  return { answered, scanned }
}
