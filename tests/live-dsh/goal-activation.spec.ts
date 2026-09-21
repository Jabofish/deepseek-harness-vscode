import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { startManagedRuntime, LIVE_TIMEOUT_MS, type ManagedLiveRuntime } from './harness.js'

/** Isolated goal lifecycle with no user prompt or provider credentials. */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live goal activation', () => {
  it(
    'reads live activation and preserves goal CAS mutations',
    async () => {
      const previousHome = process.env.DSH_HOME
      const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-goal-home-'))
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
        expect(await backend.workspaceChanges?.summary(session.id, 0)).toBeUndefined()
        expect(await backend.goals.list(session.id)).toEqual([])
        const goal = await backend.goals.create(session.id, 'Verify isolated goal lifecycle')
        expect((await backend.goals.list(session.id))[0]).toMatchObject({ id: goal.id, activation: 'armed' })
        await backend.goals.update(goal.id, { status: 'pending' })
        expect((await backend.goals.list(session.id))[0]).toMatchObject({
          activation: 'disarmed',
          status: 'pending',
        })
        await backend.goals.update(goal.id, { status: 'in-progress' })
        expect((await backend.goals.list(session.id))[0]).toMatchObject({
          activation: 'armed',
          status: 'in-progress',
        })
        await backend.goals.clear!(goal.id)
        expect(await backend.goals.list(session.id)).toEqual([])
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
