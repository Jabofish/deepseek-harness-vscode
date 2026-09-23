import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { startManagedRuntime, LIVE_TIMEOUT_MS, type ManagedLiveRuntime } from './harness.js'

/** No model call: only this test's isolated session is archived and, when the selected upstream contract supports it, restored. */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live archive restoration', () => {
  it(
    'matches the selected upstream contract for archive restoration',
    async () => {
      const previousHome = process.env.DSH_HOME
      const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-archive-home-'))
      process.env.DSH_HOME = home
      let runtime: ManagedLiveRuntime | undefined
      try {
        runtime = await startManagedRuntime()
        const { backend } = runtime
        const workspace = await backend.workspaces.create({
          name: 'Archive test',
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
        await backend.sessions.setArchived(session.id, true)
        expect((await backend.sessions.list({ archived: true })).items.map((item) => item.id)).toContain(
          session.id,
        )
        if (backend.connection.capabilities.sessionRestore === true) {
          await backend.sessions.setArchived(session.id, false)
          expect(
            (await backend.sessions.list({ archived: true })).items.map((item) => item.id),
          ).not.toContain(session.id)
          expect(
            (await backend.sessions.list({ workspaceId: workspace.id })).items.map((item) => item.id),
          ).toContain(session.id)
        } else {
          await expect(backend.sessions.setArchived(session.id, false)).rejects.toMatchObject({
            code: 'CAPABILITY_UNAVAILABLE',
          })
        }
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
