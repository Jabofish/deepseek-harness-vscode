import { describe, expect, it } from 'vitest'

import { canConnect, LIVE_TIMEOUT_MS, startManagedRuntime } from './harness.js'

/**
 * Exact 0.2.1-alpha.1 / 5badb15009ae1756c3afe0ae0cef1faafc290ccc, Windows.
 * DSH_LIVE_SMOKE=1, DSH_LIVE_RUNTIME_VERSION=0.2.1-alpha.1,
 * DSH_LIVE_RUNTIME=<isolated exact package executable>.
 * Uses only the harness-owned process, temporary workspace and empty home.
 * run.spec.ts separately verifies timed question Remotes and session creation.
 * No model/authorization/install requests: this proves the shipped Remote
 * composition, read/watch lifecycle and absence of the retired Schedule bundle.
 */
describe.skipIf(
  process.env.DSH_LIVE_SMOKE !== '1' || process.env.DSH_LIVE_RUNTIME_VERSION !== '0.2.1-alpha.1',
)('live DSH alpha211 shipped surfaces', () => {
  it(
    'reads the mounted Schedule service, Plugin Manager and account state and releases streams',
    async () => {
      const runtime = await startManagedRuntime()
      const steps = runtime.steps
      try {
        const { backend } = runtime
        expect(backend.connection.capabilities.adapterId).toBe('dsh-0.2.1-alpha.1')
        const schedules = backend.schedules
        const plugins = backend.pluginBundles
        const account = backend.account
        if (schedules === undefined || plugins === undefined || account === undefined)
          throw new Error('the exact alpha211 backend is missing a required port')
        await expect(schedules.catalog()).resolves.toEqual([])
        steps.push('shipped Schedule catalog is available and empty')
        const bundles = await plugins.listBundles()
        expect(
          bundles.some(
            (bundle) =>
              bundle.optional && bundle.rows.some((row) => row.moduleName === '@deepseek-ai/dsh-schedule'),
          ),
        ).toBe(false)
        for (const bundle of bundles) expect(bundle).not.toHaveProperty('source')
        await plugins.listPlugins()
        await plugins.registries()
        steps.push('Plugin Manager catalog/entries/registries mapped; sources omitted')
        await expect(account.getState()).resolves.toMatchObject({ status: 'signed-out', attempt: null })
        const controller = new AbortController()
        const watch = account.watch(controller.signal)[Symbol.asyncIterator]()
        try {
          expect((await watch.next()).value).toMatchObject({ status: 'signed-out', attempt: null })
        } finally {
          controller.abort()
          await watch.return?.()
        }
        steps.push('account getState/watch and cancellation released')
        const inspector = backend.inspectorDevtools
        const mods = backend.modsBand
        if (inspector === undefined || mods === undefined)
          throw new Error('the alpha211 optional surface ports are missing')
        await expect(inspector.discover()).resolves.toEqual({ available: false })
        const roster = await backend.presets.list()
        expect(roster.presets.some((preset) => preset.id === 'cordis' && preset.broken === undefined)).toBe(
          true,
        )
        const workspace = await backend.workspaces.create({
          name: 'Optional surface test',
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
        await expect(backend.subagents.list(session.id)).resolves.toMatchObject({ entries: [] })
        await expect(mods.read(session.id)).resolves.toEqual({ available: false, snapshot: null })
        steps.push(
          'Creator discovered; unmounted mods and Inspector safely unavailable without port scanning',
        )
      } finally {
        await runtime.stop()
        expect(await canConnect(runtime.snapshot.port)).toBe(false)
        for (const step of steps) console.log(`[dsh-live-alpha211] ${step}`)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
