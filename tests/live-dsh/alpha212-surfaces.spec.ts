import { describe, expect, it } from 'vitest'
import { PluginBundleUseCases } from '../../packages/application/src/use-cases/plugin-bundle-use-cases.js'
import { canConnect, LIVE_TIMEOUT_MS, startManagedRuntime } from './harness.js'

/** Exact npm alpha.2, d743267388641bc76f17c45ce8b4c231aed1d32c.
 * Only a harness-owned process with disposable workspace and home; no model, account or package mutation.
 */
describe.skipIf(
  process.env.DSH_LIVE_SMOKE !== '1' || process.env.DSH_LIVE_RUNTIME_VERSION !== '0.2.1-alpha.2',
)('live DSH alpha212 shipped contracts', () => {
  it(
    'reads official inventory and opens V4 Sessions with current format status',
    async () => {
      const runtime = await startManagedRuntime()
      try {
        const { backend } = runtime
        expect(backend.connection.capabilities.adapterId).toBe('dsh-0.2.1-alpha.2')
        const catalog = await new PluginBundleUseCases(backend).list()
        expect(catalog.available).toBe(true)
        expect(catalog.bundles.length).toBeGreaterThan(0)
        for (const bundle of catalog.bundles) {
          expect(typeof bundle.official).toBe('boolean')
          expect(['installation', 'profile', 'missing']).toContain(bundle.availability)
          expect(bundle).not.toHaveProperty('installTarget')
          expect(bundle).not.toHaveProperty('source')
        }
        expect(
          catalog.bundles.some(
            (bundle) => bundle.installable === true && bundle.targetVersion === '0.2.1-alpha.2',
          ),
        ).toBe(true)
        const workspace = await backend.workspaces.create({
          name: 'Fixture',
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
        if (backend.sessions.open === undefined)
          throw new Error('The exact adapter must support session open')
        expect((await backend.sessions.open(session.id)).formatStatus).toBe('current')
        expect(
          (await backend.sessions.list()).items.find((item) => item.id === session.id)?.formatStatus,
        ).toBe('current')
        expect(await backend.subagents.list(session.id)).toMatchObject({ entries: [] })
        expect(await backend.schedules?.catalog()).toEqual([])
        expect(await backend.account?.getState()).toMatchObject({ status: 'signed-out' })
        expect(await backend.inspectorDevtools?.discover()).toEqual({ available: false })
        expect(await backend.modsBand?.read(session.id)).toEqual({ available: false, snapshot: null })
      } finally {
        await runtime.stop()
        expect(await canConnect(runtime.snapshot.port)).toBe(false)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
