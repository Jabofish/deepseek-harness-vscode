import { describe, expect, it } from 'vitest'

import { LIVE_TIMEOUT_MS, canConnect, startManagedRuntime } from './harness.js'

/**
 * Live DSH evidence run for the connection story: the real managed launch
 * contract, the real versioned probe and the real adapter for the running
 * build, against a DSH the test itself starts and stops.
 *
 * Opt-in because it needs an installed DSH and binds a loopback port:
 *
 *   $env:DSH_LIVE_SMOKE = '1'
 *   $env:DSH_LIVE_RUNTIME = 'C:\path\to\dsh.cmd'      # defaults to `dsh` on PATH
 *   $env:DSH_LIVE_RUNTIME_VERSION = '0.1.5-rc.1'      # defaults to the pinned runtime
 *   npx vitest run tests/live-dsh/run.spec.ts
 *
 * Only the process started here is signalled; an external DSH is never
 * touched, and the teardown asserts the loopback port is released.
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live DSH connection smoke', () => {
  it(
    'starts the managed web profile, probes it, reads sessions and releases the port',
    async () => {
      const runtime = await startManagedRuntime({
        ...(process.env.DSH_LIVE_RUNTIME === undefined
          ? {}
          : { requestedRuntime: process.env.DSH_LIVE_RUNTIME }),
        ...(process.env.DSH_LIVE_RUNTIME_VERSION === undefined
          ? {}
          : { runtimeVersion: process.env.DSH_LIVE_RUNTIME_VERSION }),
      })
      const steps = runtime.steps
      try {
        const { backend } = runtime
        const page = await backend.sessions.list()
        expect(Array.isArray(page.items)).toBe(true)
        steps.push(`session.list ${page.items.length} session(s)`)
        const workspaces = await backend.workspaces.list()
        steps.push(`workspace.list ${workspaces.length} workspace(s)`)
        const unsubscribe = backend.events.subscribe(() => undefined)
        unsubscribe()
        steps.push('events.subscribe released')
      } finally {
        await runtime.stop()
        const released = !(await canConnect(runtime.snapshot.port))
        steps.push(`managed stop port ${runtime.snapshot.port} closed=${String(released)}`)
        for (const step of steps) console.log(`[dsh-live-smoke] ${step}`)
        expect(released, `loopback port ${runtime.snapshot.port} must be released`).toBe(true)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
