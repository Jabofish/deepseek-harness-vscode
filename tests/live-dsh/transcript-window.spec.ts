import { describe, expect, it } from 'vitest'
import { TranscriptWindowService } from '../../apps/extension/src/view/transcript-window.js'
import { sanitizePublicValue } from '../../apps/extension/src/view/public-value.js'
import { startManagedRuntime, LIVE_TIMEOUT_MS } from './harness.js'

// Fixed rc.1 / rc.2 tool-todo projection and Session Controller sources are
// pinned in docs/dsh-contract.md. This needs no provider key or model request.
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live DSH authoritative transcript opening', () => {
  it(
    'opens a new isolated session through the actual Adapter and installs its authoritative Host window',
    async () => {
      const runtime = await startManagedRuntime()
      const { backend } = runtime
      const service = new TranscriptWindowService({
        read: (sessionId, before, signal) =>
          backend.sessions.history(sessionId, before, signal, { pageSize: 50, pagePurpose: 'transcript' }),
        publicValue: (value, cwd) => sanitizePublicValue(value, undefined, [runtime.snapshot.workspace], cwd),
        post: () => Promise.resolve(true),
      })
      const unsubscribe = backend.events.subscribe((event) => {
        service.accept(event)
      })
      try {
        const workspace = await backend.workspaces.create({
          name: 'Transcript fixture',
          path: runtime.snapshot.workspace,
        })
        const permissionCatalog =
          runtime.snapshot.version === '0.2.1-rc.2'
            ? await backend.sessions.readPermissionCatalog?.()
            : undefined
        if (runtime.snapshot.version === '0.2.1-rc.2') {
          expect(permissionCatalog?.defaultPreset).toEqual(expect.any(String))
          expect(permissionCatalog?.items).toContain(permissionCatalog?.defaultPreset)
        }
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
        if (runtime.snapshot.version === '0.2.1-rc.2') {
          // No model request: first-send preparation must preserve unchosen
          // policy defaults, then apply explicit choices through native commands.
          await backend.sessions.setConfiguration(session.id, {
            ...session.configuration,
            permissionPreset: 'workspace-write',
            permissionPresetKnown: false,
            planModeKnown: false,
          })
          const before = await backend.sessions.get(session.id)
          expect(before.configuration.permissionPreset).toBe(permissionCatalog?.defaultPreset)
          expect(before.permissionPresets).toContain('read-only')
          await backend.sessions.setConfiguration(session.id, {
            ...before.configuration,
            permissionPreset: 'read-only',
            permissionPresetKnown: true,
            planMode: true,
            planModeKnown: true,
          })
          const configured = await backend.sessions.get(session.id)
          expect(configured.configuration).toMatchObject({
            permissionPreset: 'read-only',
            permissionPresetKnown: true,
            planMode: true,
            planModeKnown: true,
          })
          runtime.steps.push('native pre-send permission/Plan changes read back authoritatively')
        }
        const generation = service.begin(session.id)
        const detail =
          backend.sessions.open === undefined
            ? await backend.sessions.get(session.id)
            : await backend.sessions.open(session.id)
        const window = service.install(detail, generation)
        expect(window.sessionId).toBe(session.id)
        expect(window.nodes.length).toBeLessThanOrEqual(256)
        expect(window).not.toHaveProperty('history')
        expect(JSON.stringify(window)).not.toContain(runtime.snapshot.workspace.replaceAll('\\', '\\\\'))
        if (['0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2'].includes(runtime.snapshot.version))
          expect(detail.projection?.values.todoList).toBeNull()
        runtime.steps.push('session.create/open and Host window installed; current Todo baseline checked')
      } finally {
        unsubscribe()
        service.dispose()
        await runtime.stop()
        for (const step of runtime.steps) console.log(`[dsh-transcript-window] ${step}`)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
