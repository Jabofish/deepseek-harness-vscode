import { describe, expect, it } from 'vitest'
import { canConnect, startManagedRuntime, LIVE_TIMEOUT_MS, type ManagedLiveRuntime } from './harness.js'

/** Isolated intake smoke; no credentials are loaded from the user profile. */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live binary upload', () => {
  it(
    'persists a binary file receipt in the receiving session',
    async () => {
      let runtime: ManagedLiveRuntime | undefined
      let unsubscribe: (() => void) | undefined
      let phase = 'runtime startup'
      try {
        runtime = await startManagedRuntime()
        const { backend } = runtime
        // Session creation reads the permission catalog after the Host event handshake.
        unsubscribe = backend.events.subscribe(() => undefined)
        const signal = AbortSignal.timeout(30_000)
        phase = 'workspace creation'
        const workspace = await backend.workspaces.create(
          {
            name: 'Permission test',
            path: runtime.snapshot.workspace,
          },
          signal,
        )
        phase = 'session creation'
        const session = await backend.sessions.create(
          {
            workspaceId: workspace.id,
            configuration: {
              preset: '',
              toolMode: 'native',
              permissionPreset: '',
              planMode: false,
              model: { providerId: '', modelId: '' },
            },
          },
          signal,
        )
        // The throwaway home has no provider credentials. Assert intake and
        // durable history, not the expected model failure after admission.
        phase = 'binary prompt admission'
        await backend.sessions.sendPrompt(
          {
            sessionId: session.id,
            text: 'binary intake probe',
            attachments: [
              {
                name: 'probe.bin',
                mimeType: 'application/octet-stream',
                uri: 'data:application/octet-stream;base64,AAECAw==',
              },
            ],
          },
          'queue',
          signal,
        )
        phase = 'attachment history'
        await expect
          .poll(
            async () => {
              const page = await backend.sessions.history(session.id, undefined, signal)
              return page.events.flatMap((row) =>
                row.event.type === 'message.user' ? (row.event.attachments ?? []) : [],
              )
            },
            { timeout: 15_000, interval: 250 },
          )
          .toContainEqual({ name: 'probe.bin' })
      } catch (cause) {
        throw new Error(`Live binary upload failed during ${phase}`, { cause })
      } finally {
        unsubscribe?.()
        if (runtime !== undefined) {
          await runtime.stop()
          expect(await canConnect(runtime.snapshot.port)).toBe(false)
        }
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
