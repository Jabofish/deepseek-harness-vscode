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
 *   $env:DSH_LIVE_RUNTIME_VERSION = '0.1.5-rc.3'      # defaults to the pinned runtime
 *   npx vitest run tests/live-dsh/run.spec.ts
 *
 * Only the process started here is signalled; an external DSH is never
 * touched, and the teardown asserts the loopback port is released.
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live DSH connection smoke', () => {
  it(
    'starts the managed web profile, probes it, reads sessions and releases the port',
    async () => {
      const runtime = await startManagedRuntime()
      const steps = runtime.steps
      try {
        const { backend } = runtime
        if (runtime.snapshot.version === '0.2.0-rc.2') {
          expect(
            backend.userQuestions,
            'the exact rc.2 adapter must expose timed userQuestions',
          ).toBeDefined()
          if (backend.userQuestions === undefined)
            throw new Error('the rc.2 timed userQuestions port is missing')
          const workspace = await backend.workspaces.create({
            name: 'Timed question smoke',
            path: runtime.snapshot.workspace,
          })
          const session = await backend.sessions.create({
            workspaceId: workspace.id,
            configuration: {
              preset: '',
              toolMode: 'native',
              permissionPreset: '',
              planMode: false,
              model: { providerId: '', modelId: '' },
            },
          })
          await expect(
            backend.userQuestions.answer(session.id, 'missing-question-call', {
              answers: [{ id: 'missing-question', selected: [] }],
            }),
          ).resolves.toBe(false)
          await expect(
            backend.userQuestions.attachWait(session.id, 'missing-question-call'),
          ).resolves.toBeUndefined()
          steps.push('userQuestions.answer unknown and attachWait closed-stream routes passed')
        }
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
