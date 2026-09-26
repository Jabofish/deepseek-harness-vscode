import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { startManagedRuntime, LIVE_TIMEOUT_MS, type ManagedLiveRuntime } from './harness.js'

/** Isolated intake smoke; no credentials are loaded from the user profile. */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live binary upload', () => {
  it(
    'persists a binary file receipt in the receiving session',
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-permission-home-'))
      let runtime: ManagedLiveRuntime | undefined
      try {
        runtime = await startManagedRuntime({ dshHome: home, removeDshHomeOnStop: true })
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
        // The throwaway home has no provider credentials. Assert intake and
        // durable history, not the expected model failure after admission.
        await backend.sessions.sendPrompt({
          sessionId: session.id,
          text: 'binary intake probe',
          attachments: [
            {
              name: 'probe.bin',
              mimeType: 'application/octet-stream',
              uri: 'data:application/octet-stream;base64,AAECAw==',
            },
          ],
        })
        await expect
          .poll(
            async () => {
              const detail = await backend.sessions.get(session.id)
              return (detail.history ?? []).flatMap((row) =>
                row.event.type === 'message.user' ? (row.event.attachments ?? []) : [],
              )
            },
            { timeout: 15_000, interval: 250 },
          )
          .toContainEqual({ name: 'probe.bin' })
      } finally {
        await runtime?.stop()
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
