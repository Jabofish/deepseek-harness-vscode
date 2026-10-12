import { describe, expect, it } from 'vitest'
import { canConnect, LIVE_TIMEOUT_MS, startManagedRuntime } from './harness.js'

describe.skipIf(
  process.env.DSH_LIVE_SMOKE !== '1' || process.env.DSH_LIVE_RUNTIME_VERSION !== '0.2.1-alpha.2',
)('live DSH session summary freshness on an isolated home', () => {
  it(
    'reopens a cached blank session with its accepted title and newly selected preset',
    async () => {
      const runtime = await startManagedRuntime()
      try {
        const { backend } = runtime
        const workspace = await backend.workspaces.create({
          name: 'Summary fixture',
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
        const cached = (await backend.sessions.list()).items.find((row) => row.id === created.id)
        expect(cached).toMatchObject({ blank: true, status: 'idle' })
        const accepted = await backend.sessions.rename(created.id, 'Accepted summary title')
        const presets = (await backend.presets.list()).presets
        const nextPreset = presets.find(
          (preset) => !preset.broken && preset.id !== created.configuration.preset,
        )
        if (nextPreset === undefined) throw new Error('The pinned fixture must advertise an alternate preset')
        await backend.sessions.setConfiguration(created.id, {
          ...created.configuration,
          preset: nextPreset.id,
          model: { providerId: '', modelId: '' },
        })
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const detail = await backend.sessions.open?.(created.id)
          expect(detail).toMatchObject({
            title: accepted,
            agentPreset: nextPreset.id,
            blank: true,
            status: 'idle',
            updatedAt: cached?.updatedAt,
            configuration: { preset: nextPreset.id },
          })
        }
        const listed = (await backend.sessions.list()).items.find((row) => row.id === created.id)
        expect(listed).toMatchObject({
          title: accepted,
          agentPreset: nextPreset.id,
          blank: true,
          status: 'idle',
          updatedAt: cached?.updatedAt,
        })
      } finally {
        await runtime.stop()
        expect(await canConnect(runtime.snapshot.port)).toBe(false)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
