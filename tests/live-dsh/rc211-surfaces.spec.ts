import { describe, expect, it } from 'vitest'
import { PluginBundleUseCases } from '../../packages/application/src/use-cases/plugin-bundle-use-cases.js'
import { canConnect, LIVE_TIMEOUT_MS, startManagedRuntime } from './harness.js'

/** Exact published 0.2.1 alpha.3/.4/.5 and rc.1/.2/.3; pins in rc211-contract.spec.ts.
 * Only a harness-owned process with disposable workspace and home; no model, account or package mutation.
 */
const version = process.env.DSH_LIVE_RUNTIME_VERSION ?? ''
const releases = ['0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-alpha.5', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3']

describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1' || !releases.includes(version))(
  'live DSH 0.2.1 incremental shipped contracts',
  () => {
    it(
      'reads official inventory and opens V4 Sessions with current format status',
      async () => {
        const runtime = await startManagedRuntime()
        try {
          const { backend } = runtime
          if (version === '0.2.1-rc.2' || version === '0.2.1-rc.3') {
            const settings = backend.settings
            const initial = await settings.readSnapshot()
            const selection = initial.schema.namespaces.find((entry) => entry.ns === 'web')!
            const api = initial.schema.namespaces.find((entry) => entry.ns === 'web-deepseek-api')!
            expect(selection.applies).toBe('live')
            expect(api.applies).toBe('live')
            expect(initial.schema.fields).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  path: 'web.searchProvider',
                  type: 'string',
                  restartRequired: false,
                }),
                expect.objectContaining({
                  path: 'web.fetchProvider',
                  type: 'string',
                  restartRequired: false,
                }),
                expect.objectContaining({
                  path: 'web-deepseek-api.count',
                  type: 'number',
                  restartRequired: false,
                }),
                expect.objectContaining({
                  path: 'web-deepseek-api.sendOriginalQuestion',
                  type: 'boolean',
                  restartRequired: false,
                }),
                expect.objectContaining({ path: 'web-deepseek-api.apiKey', type: 'secret' }),
              ]),
            )
            expect(api.secrets).toContainEqual({ field: 'apiKey', set: false })
            expect(initial.values['web-deepseek-api']).toHaveProperty('apiKey', undefined)
            await settings.mutate(
              'web-deepseek-api',
              [
                { op: 'set', path: ['count'], value: 7 },
                { op: 'set', path: ['sendOriginalQuestion'], value: false },
              ],
              api.revision,
            )
            await settings.mutate(
              'web',
              [
                { op: 'set', path: ['searchProvider'], value: 'deepseek-search-api' },
                { op: 'set', path: ['fetchProvider'], value: 'deepseek-fetch-api' },
              ],
              selection.revision,
            )
            const changed = await settings.readSnapshot()
            expect(changed.values['web']).toMatchObject({
              searchProvider: 'deepseek-search-api',
              fetchProvider: 'deepseek-fetch-api',
            })
            expect(changed.values['web-deepseek-api']).toMatchObject({
              count: 7,
              sendOriginalQuestion: false,
            })
            const apiRevision = changed.schema.namespaces.find((entry) => entry.ns === api.ns)!.revision
            await expect(
              settings.mutate(api.ns, [{ op: 'set', path: ['count'], value: 51 }], apiRevision),
            ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
            await expect(
              settings.mutate(api.ns, [{ op: 'set', path: ['count'], value: 8 }], api.revision),
            ).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' })
            const fresh = await settings.readSnapshot()
            for (const [ns, fields] of [
              ['web', ['searchProvider', 'fetchProvider']],
              ['web-deepseek-api', ['count', 'sendOriginalQuestion']],
            ] as const) {
              const original = initial.values[ns] as Record<string, unknown>
              const metadata = initial.schema.namespaces.find((entry) => entry.ns === ns)!
              await settings.mutate(
                ns,
                fields.map((field) =>
                  metadata.userFields.includes(field)
                    ? { op: 'set' as const, path: [field], value: original[field] }
                    : { op: 'unset' as const, path: [field] },
                ),
                fresh.schema.namespaces.find((entry) => entry.ns === ns)!.revision,
              )
            }
            const restored = await settings.readSnapshot()
            expect(restored.values['web']).toEqual(initial.values['web'])
            expect(restored.values['web-deepseek-api']).toEqual(initial.values['web-deepseek-api'])
          }
          expect(backend.connection.capabilities.adapterId).toBe(`dsh-${version}`)
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
            catalog.bundles.some((bundle) => bundle.installable === true && bundle.targetVersion === version),
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
          await backend.sessions.cancel(session.id)
          expect((await backend.sessions.get(session.id)).id).toBe(session.id)
          await backend.sessions.setArchived(session.id, true)
          expect(await backend.workspaces.listArchivedSessionIds()).toContain(session.id)
          await backend.sessions.setArchived(session.id, false)
          expect(await backend.workspaces.listArchivedSessionIds()).not.toContain(session.id)
          await backend.workspaces.rename(workspace.id, 'Renamed fixture')
          expect((await backend.workspaces.list()).find((item) => item.id === workspace.id)?.name).toBe(
            'Renamed fixture',
          )
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
  },
)
