import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { startManagedRuntime, LIVE_TIMEOUT_MS, type ManagedLiveRuntime } from './harness.js'

/** No model call: only an isolated Session's permission command and authoritative read. */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live permission catalog', () => {
  it(
    'discovers and switches every ordinary preset on the exact runtime',
    async () => {
      const previousHome = process.env.DSH_HOME
      const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-permission-home-'))
      process.env.DSH_HOME = home
      let runtime: ManagedLiveRuntime | undefined
      try {
        runtime = await startManagedRuntime()
        const { backend } = runtime
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
        console.log(
          `[permission-catalog] ${runtime.snapshot.version}: catalog and three permission switches passed`,
        )
      } finally {
        await runtime?.stop()
        if (previousHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousHome
        await rm(home, { recursive: true, force: true })
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
