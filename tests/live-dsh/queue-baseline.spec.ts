import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { AgentConfiguration } from '../../packages/domain/src/models.js'
import { LIVE_TIMEOUT_MS, canConnect, startManagedRuntime, type ManagedLiveRuntime } from './harness.js'

/** The host resolves these from the session's own defaults when they are blank. */
const blankSessionConfiguration: AgentConfiguration = {
  preset: '',
  toolMode: 'native',
  permissionPreset: '',
  planMode: false,
  model: { providerId: '', modelId: '' },
}

/**
 * The queue a fresh Session exposes on the alpha/rc line, read in the order the
 * Extension Host and the Webview read it: `session.open`, then `queue.list`.
 *
 * The real host answers this shape from a baseline that lists every Session it
 * knows, and it broadcasts a queue frame only when pending input changes — a
 * Session created after that baseline (every "new session", which is where the
 * Webview read starts) is therefore named by neither. The reference client
 * materializes such a Session as an empty queue (`queues.get(id) ?? []`), so a
 * client that treats the absence as unreadable shows a permanent "input queue
 * could not be read" banner for every new Session. `$DSH_HOME` points at a
 * throwaway directory, so the probe creates, reads and archives its own Session
 * without touching the user profile, and no model turn is started.
 *
 *   $env:DSH_LIVE_SMOKE = '1'
 *   npx vitest run tests/live-dsh/queue-baseline.spec.ts
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live DSH queue baseline', () => {
  it(
    'answers the queue of a Session the control baseline never named',
    async () => {
      const previousHome = process.env.DSH_HOME
      const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-home-'))
      process.env.DSH_HOME = home
      const steps: string[] = []
      let runtime: ManagedLiveRuntime | undefined
      try {
        runtime = await startManagedRuntime()
        const { backend } = runtime
        const unsubscribe = backend.events.subscribe(() => undefined)
        try {
          const workspace = await backend.workspaces.create({
            name: 'DSH VSC queue baseline probe',
            path: runtime.snapshot.workspace,
          })
          const session = await backend.sessions.create({
            workspaceId: workspace.id,
            configuration: blankSessionConfiguration,
          })
          const detail = await backend.sessions.get(session.id)
          steps.push(`sessions.create status=${session.status} open status=${detail.status}`)

          const opened = Date.now()
          const items = await backend.sessions.listQueue(session.id)
          const elapsed = Date.now() - opened
          expect(items, 'a Session with nothing pending has the empty queue').toEqual([])
          expect(elapsed, 'the read must not wait out a baseline that never arrives').toBeLessThan(1_000)
          steps.push(`queue.list ${items.length} item(s) in ${elapsed}ms after open`)

          const afterSubscribe = await backend.sessions.listQueue(session.id)
          expect(afterSubscribe, 'a subscription must not change the answer').toEqual([])
          steps.push('queue.list unchanged by the session subscription')

          await backend.sessions.setArchived(session.id, true)
          await backend.workspaces.remove(workspace.id)
        } finally {
          unsubscribe()
        }
      } finally {
        let released: boolean | undefined
        if (runtime !== undefined) {
          await runtime.stop()
          released = !(await canConnect(runtime.snapshot.port))
          steps.push(`managed stop port ${runtime.snapshot.port} released=${String(released)}`)
        }
        if (previousHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousHome
        await rm(home, { recursive: true, force: true })
        for (const step of steps) console.log(`[dsh-live-queue] ${step}`)
        if (released !== undefined)
          expect(released, `loopback port ${runtime?.snapshot.port ?? 0} must be released`).toBe(true)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
