import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { startManagedRuntime, LIVE_TIMEOUT_MS, type ManagedLiveRuntime } from './harness.js'

/** No model call: only an isolated Session's permission command and authoritative read. */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live permission catalog', () => {
  it(
    'discovers and switches every ordinary preset on the exact runtime',
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-permission-home-'))
      let runtime: ManagedLiveRuntime | undefined
      let disposeEvents: (() => void) | undefined
      try {
        runtime = await startManagedRuntime({ dshHome: home, removeDshHomeOnStop: true })
        const { backend } = runtime
        // The process catalog is not replayed. Register $events before the
        // first read, as the Extension Host does on a connected View.
        disposeEvents = backend.events.subscribe(() => undefined)
        const workspace = await backend.workspaces.create({
          name: 'Permission test',
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
        const detail = await backend.sessions.get(session.id)
        expect(detail.permissionPresets).toEqual(expect.arrayContaining(['read-only', 'workspace-write']))
        for (const preset of detail.permissionPresets?.filter((id) => id !== 'auto') ?? []) {
          await backend.commands.execute(session.id, `/permission ${preset}`)
          expect((await backend.sessions.get(session.id)).configuration.permissionPreset).toBe(preset)
        }
        console.log(`[permission-catalog] ${runtime.snapshot.version}: catalog and ordinary switches passed`)
      } finally {
        disposeEvents?.()
        await runtime?.stop()
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
