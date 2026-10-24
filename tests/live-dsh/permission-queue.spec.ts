import { describe, expect, it, vi } from 'vitest'
import { startManagedRuntime, LIVE_TIMEOUT_MS } from './harness.js'

/** dsh-v0.2.1-rc.3 / 1f81c047fc48fa190a683e469daa699857e9afe8.
 * user-approval/src/index.ts injects policy changes with source user-approval;
 * ui-chat/src/client/chat/ChatView.tsx excludes non-user next-step messages.
 * This changes only an isolated session, without sending a model request.
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1' || process.env.DSH_LIVE_RUNTIME_VERSION !== '0.2.1-rc.3')(
  'live permission changes and the displayed input queue',
  () => {
    it(
      'retains internal policy context in DSH while excluding it from live and reopened input queues',
      async () => {
        const runtime = await startManagedRuntime()
        const { backend } = runtime
        let sawInternalPolicy = false
        const unsubscribe = backend.events.subscribe((event) => {
          if (event.type !== 'session.projection' || event.key !== 'inbox') return
          const value = event.value
          if (
            typeof value !== 'object' ||
            value === null ||
            !('next-step' in value) ||
            !Array.isArray(value['next-step'])
          )
            return
          const messages: readonly unknown[] = value['next-step']
          for (const message of messages) {
            if (typeof message !== 'object' || message === null || !('source' in message)) continue
            const source: unknown = message.source
            if (
              typeof source === 'object' &&
              source !== null &&
              'kind' in source &&
              source.kind === 'user-approval'
            )
              sawInternalPolicy = true
          }
        })
        try {
          const workspace = await backend.workspaces.create({
            name: 'Permission queue fixture',
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
          expect(detail.permissionPresets).toEqual(
            expect.arrayContaining(['read-only', 'danger-full-access']),
          )
          for (const preset of ['read-only', 'danger-full-access']) {
            await backend.commands.execute(session.id, `/permission ${preset}`)
            expect((await backend.sessions.get(session.id)).configuration.permissionPreset).toBe(preset)
          }
          await vi.waitFor(() => expect(sawInternalPolicy).toBe(true), { timeout: 10_000 })
          expect(await backend.sessions.listQueue(session.id)).toEqual([])
          expect(typeof backend.sessions.open).toBe('function')
          await backend.sessions.open!(session.id)
          expect(await backend.sessions.listQueue(session.id)).toEqual([])
          expect((await backend.sessions.get(session.id)).configuration.permissionPreset).toBe(
            'danger-full-access',
          )
        } finally {
          unsubscribe()
          await runtime.stop()
        }
      },
      LIVE_TIMEOUT_MS,
    )
  },
)
