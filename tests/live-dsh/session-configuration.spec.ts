import { describe, expect, it, vi } from 'vitest'
import { canConnect, LIVE_TIMEOUT_MS, startManagedRuntime, type ManagedLiveRuntime } from './harness.js'

describe.skipIf(
  process.env.DSH_LIVE_SMOKE !== '1' || process.env.DSH_LIVE_RUNTIME_VERSION !== '0.2.1-alpha.2',
)('live DSH session configuration on an isolated home', () => {
  it(
    'restores a permission change whose real successful HTTP receipt is lost during cancellation',
    async () => {
      const controller = new AbortController()
      let loseReceipt = false
      let commandRequests = 0
      let observeCommands = false
      const originalFetch = globalThis.fetch
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
        const response = await originalFetch(...args)
        const url = args[0] instanceof Request ? args[0].url : args[0] instanceof URL ? args[0].href : args[0]
        if (observeCommands && new URL(url).pathname === '/api/commands/execute') {
          commandRequests++
          if (loseReceipt) {
            loseReceipt = false
            // The real handler has settled and its body arrived. Lose only
            // client receipt delivery, after the server committed the change.
            await response.clone().arrayBuffer()
            controller.abort()
            throw new DOMException('Fixture receipt delivery cancelled.', 'AbortError')
          }
        }
        return response
      })
      let runtime: ManagedLiveRuntime | undefined
      let unsubscribe: (() => void) | undefined
      try {
        runtime = await startManagedRuntime()
        const { backend } = runtime
        unsubscribe = backend.events.subscribe(() => undefined)
        const workspace = await backend.workspaces.create({
          name: 'Lost receipt fixture',
          path: runtime.snapshot.workspace,
        })
        const created = await backend.sessions.create({
          workspaceId: workspace.id,
          configuration: {
            preset: '',
            toolMode: 'native',
            permissionPreset: '',
            planMode: false,
            model: { providerId: '', modelId: '' },
          },
        })
        const baseline = await backend.sessions.get(created.id)
        const permission = baseline.permissionPresets?.find(
          (value) => value !== baseline.configuration.permissionPreset && value !== 'auto',
        )
        if (permission === undefined) throw new Error('The fixture needs an alternate permission preset')
        observeCommands = true
        loseReceipt = true
        await expect(
          backend.sessions.setConfiguration(
            created.id,
            { ...baseline.configuration, permissionPreset: permission },
            controller.signal,
          ),
        ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
        expect((await backend.sessions.get(created.id)).configuration).toEqual(baseline.configuration)
        expect(commandRequests).toBe(2)
      } finally {
        unsubscribe?.()
        try {
          if (runtime !== undefined) {
            await runtime.stop()
            expect(await canConnect(runtime.snapshot.port)).toBe(false)
          }
        } finally {
          fetchSpy.mockRestore()
        }
      }
    },
    LIVE_TIMEOUT_MS,
  )

  it(
    'preserves native command refusals and restores a failed update before a later update succeeds',
    async () => {
      const runtime = await startManagedRuntime()
      // Match Host attachment: catalog reads follow the live event listener registration.
      const unsubscribe = runtime.backend.events.subscribe(() => undefined)
      try {
        const { backend } = runtime
        const workspace = await backend.workspaces.create({
          name: 'Configuration fixture',
          path: runtime.snapshot.workspace,
        })
        const created = await backend.sessions.create({
          workspaceId: workspace.id,
          configuration: {
            preset: '',
            toolMode: 'native',
            permissionPreset: '',
            planMode: false,
            model: { providerId: '', modelId: '' },
          },
        })
        const baseline = await backend.sessions.get(created.id)
        expect(baseline.configuration).toMatchObject({
          permissionPresetKnown: true,
          planModeKnown: true,
        })
        const nextPermission = baseline.permissionPresets?.find(
          (value) => value !== baseline.configuration.permissionPreset && value !== 'auto',
        )
        if (nextPermission === undefined)
          throw new Error('The pinned fixture must advertise an alternate permission preset')

        const refusal = await backend.commands.execute(
          created.id,
          '/permission configuration-fixture-missing',
        )
        expect(refusal.kind).toBe('error')
        expect((await backend.sessions.get(created.id)).configuration).toEqual(baseline.configuration)

        await expect(
          backend.sessions.setConfiguration(created.id, {
            ...baseline.configuration,
            permissionPreset: nextPermission,
            planMode: !baseline.configuration.planMode,
            model: {
              providerId: 'configuration-fixture-unavailable',
              modelId: 'configuration-fixture-unavailable',
            },
          }),
        ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
        expect((await backend.sessions.get(created.id)).configuration).toEqual(baseline.configuration)

        const A = backend.sessions.setConfiguration(created.id, {
          ...baseline.configuration,
          permissionPreset: nextPermission,
          model: {
            providerId: 'configuration-fixture-unavailable',
            modelId: 'configuration-fixture-unavailable',
          },
        })
        const outcomeA = A.catch((error: unknown) => error)
        const B = backend.sessions.setConfiguration(created.id, {
          ...baseline.configuration,
          permissionPreset: nextPermission,
          planMode: !baseline.configuration.planMode,
        })
        const [errorA] = await Promise.all([outcomeA, B])
        expect(errorA).toMatchObject({ code: 'INVALID_CONFIGURATION' })
        expect((await backend.sessions.get(created.id)).configuration).toMatchObject({
          permissionPreset: nextPermission,
          planMode: !baseline.configuration.planMode,
          model: baseline.configuration.model,
        })
      } finally {
        unsubscribe()
        await runtime.stop()
        expect(await canConnect(runtime.snapshot.port)).toBe(false)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
