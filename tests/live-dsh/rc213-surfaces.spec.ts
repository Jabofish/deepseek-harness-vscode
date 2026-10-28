import { describe, expect, it } from 'vitest'
import type { AgentConfiguration } from '../../packages/domain/src/models.js'
import { canConnect, LIVE_TIMEOUT_MS, startManagedRuntime } from './harness.js'

/** dsh-v0.2.1-rc.3 / 1f81c047fc48fa190a683e469daa699857e9afe8.
 * Source: session-controller/src/{types,agent,commands}.ts;
 * ui-workspace/src/client/navigation.ts; llm-deepseek{,-api-key}/src/config.ts.
 * No prompt, paid model call, OAuth, global installation or production profile.
 */
const version = process.env.DSH_LIVE_RUNTIME_VERSION ?? ''
const protocols: Readonly<Record<string, string>> = {
  '0.2.1-rc.3': 'rc213',
  '0.2.1-rc.4': 'rc214',
  '0.2.2-alpha.2': 'alpha222',
}
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1' || protocols[version] === undefined)(
  'live rc.3 workspace blanks and model-listing configuration',
  () => {
    it(
      'adopts a named blank under its advertised preset and validates new live settings',
      async () => {
        const runtime = await startManagedRuntime()
        try {
          console.log(`[native-contract] ${version}: runtime ready`)
          const { backend } = runtime
          expect(backend.connection.capabilities).toMatchObject({
            adapterId: `dsh-${version}`,
            protocolVersion: protocols[version],
            compatibilityMode: 'exact',
            blankSessionReuse: true,
          })
          const workspace = await backend.workspaces.create({
            name: 'Fixture',
            path: runtime.snapshot.workspace,
          })
          const roster = await backend.presets.list()
          const preset = roster.presets.find((p) => p.isDefault && p.broken === undefined)!
          expect(preset).toBeDefined()
          const configuration: AgentConfiguration = {
            preset: preset.id,
            toolMode: 'native',
            permissionPreset: 'workspace-write',
            permissionPresetKnown: false,
            planMode: false,
            planModeKnown: false,
            model: { providerId: '', modelId: '' },
          }
          const original = await backend.sessions.create({ workspaceId: workspace.id, configuration })
          console.log(`[native-contract] ${version}: session created`)
          const accounting = backend.sessions.readBillingPage
          expect(accounting).toBeDefined()
          const accountingPage = await accounting!.call(backend.sessions, original.id)
          expect(accountingPage).toMatchObject({ facts: [], hasMore: false, contiguous: true })
          const cancelledRead = new AbortController()
          cancelledRead.abort()
          await expect(
            accounting!.call(backend.sessions, original.id, undefined, cancelledRead.signal),
          ).rejects.toThrow()
          const reused = await backend.sessions.create({
            workspaceId: workspace.id,
            sessionId: original.id,
            configuration,
          })
          expect(reused.id).toBe(original.id)
          expect(reused.blank).toBe(true)
          expect(reused.configuration.preset).toBe(preset.id)
          const creator = roster.presets.find((p) => p.id === 'cordis' && p.broken === undefined)!
          expect(creator).toBeDefined()
          const created = await backend.sessions.create({
            workspaceId: workspace.id,
            configuration: { ...configuration, preset: creator.id },
          })
          expect(created.id).not.toBe(original.id)
          const rows = (await backend.sessions.list()).items
          expect(rows.find((r) => r.id === original.id)?.agentPreset).toBe(preset.id)
          expect(rows.find((r) => r.id === created.id)?.agentPreset).toBe(creator.id)
          expect(
            (
              await backend.sessions.create({
                workspaceId: workspace.id,
                sessionId: created.id,
                configuration: { ...configuration, preset: creator.id },
              })
            ).id,
          ).toBe(created.id)
          // Native create decides whether a stale named candidate is still reusable.
          await backend.sessions.setArchived(original.id, true)
          const replacement = await backend.sessions.create({
            workspaceId: workspace.id,
            sessionId: original.id,
            configuration,
          })
          expect(replacement.id).not.toBe(original.id)
          expect(await backend.workspaces.listArchivedSessionIds()).toContain(original.id)

          console.log(`[native-contract] ${version}: blank reuse complete`)
          const initial = await backend.settings.readSnapshot()
          // Settings namespaces are Loader entry ids, not npm package names.
          const namespace = initial.schema.namespaces.find((ns) => ns.ns === 'llm-deepseek')!
          expect(namespace).toBeDefined()
          expect(namespace.applies).toBe('live')
          expect((initial.values[namespace.ns] as Record<string, unknown>).models).toEqual(
            expect.arrayContaining([expect.objectContaining({ contextWindow: 1_048_576 })]),
          )
          expect(initial.schema.fields).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                path: `${namespace.ns}.modelsTimeoutMs`,
                type: 'number',
                restartRequired: false,
              }),
              expect.objectContaining({
                path: `${namespace.ns}.modelsMaxAgeMs`,
                type: 'number',
                restartRequired: false,
              }),
            ]),
          )
          await backend.settings.mutate(
            namespace.ns,
            [
              { op: 'set', path: ['modelsTimeoutMs'], value: 2500 },
              { op: 'set', path: ['modelsMaxAgeMs'], value: 120000 },
            ],
            namespace.revision,
          )
          const changed = await backend.settings.readSnapshot()
          expect(changed.values[namespace.ns]).toMatchObject({
            modelsTimeoutMs: 2500,
            modelsMaxAgeMs: 120000,
          })
          const revision = changed.schema.namespaces.find((ns) => ns.ns === namespace.ns)!.revision
          await expect(
            backend.settings.mutate(
              namespace.ns,
              [{ op: 'set', path: ['modelsMaxAgeMs'], value: -1 }],
              revision,
            ),
          ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
          const fresh = await backend.settings.readSnapshot()
          await backend.settings.mutate(
            namespace.ns,
            ['modelsTimeoutMs', 'modelsMaxAgeMs'].map((field) =>
              namespace.userFields.includes(field)
                ? {
                    op: 'set' as const,
                    path: [field],
                    value: (initial.values[namespace.ns] as Record<string, unknown>)[field],
                  }
                : { op: 'unset' as const, path: [field] },
            ),
            fresh.schema.namespaces.find((ns) => ns.ns === namespace.ns)!.revision,
          )
          expect((await backend.settings.readSnapshot()).values[namespace.ns]).toEqual(
            initial.values[namespace.ns],
          )
          console.log(`[native-contract] ${version}: settings complete`)
          const catalog = await backend.models.listSessionModels(created.id)
          // The disposable profile has no credentials: do not invent a successful
          // official listing or make a paid request to populate this catalog.
          expect(catalog).toMatchObject({ models: [], routable: false })
          expect(catalog.current.providerId).not.toBe('')
        } finally {
          await runtime.stop()
          expect(await canConnect(runtime.snapshot.port)).toBe(false)
        }
      },
      version === '0.2.2-alpha.2' ? LIVE_TIMEOUT_MS * 2 : LIVE_TIMEOUT_MS,
    )
  },
)
