import { describe, expect, it } from 'vitest'
import type { BackendEvent } from '@dsh-vscode/domain'
import { startManagedRuntime, LIVE_TIMEOUT_MS } from './harness.js'
import { createSessionWatchController } from '../../apps/extension/src/backend/session-watch-coordinator.js'

/**
 * Live evidence for the session follow lifecycle (issue #13): a session is
 * policy does not follow idle directory entries, shares a visible session,
 * releases it when all panels hide, and restores it when shown again. Normal
 * opens still re-baseline history. Assertions use public backend events and
 * the real policy against an isolated Session Controller.
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live DSH session follow policy', () => {
  it(
    'shares displayed sessions, releases hidden ones, and restores their follow streams',
    async () => {
      const runtime = await startManagedRuntime()
      const subscribed: string[] = []
      const policy = createSessionWatchController({ delayMs: 150 })
      const unsubscribe = runtime.backend.events.subscribe((event: BackendEvent) => {
        if (event.type === 'session.subscribed') subscribed.push(event.sessionId)
      })
      try {
        const { backend } = runtime
        const countFor = (sessionId: string): number =>
          subscribed.filter((candidate) => candidate === sessionId).length
        const waitFor = async (predicate: () => boolean, what: string): Promise<void> => {
          const deadline = Date.now() + 15_000
          while (Date.now() < deadline && !predicate())
            await new Promise((resolve) => setTimeout(resolve, 100))
          expect(predicate(), what).toBe(true)
        }
        const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

        const workspace = await backend.workspaces.create({
          name: 'Follow policy fixture',
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
        expect(typeof backend.events.watchSession).toBe('function')
        expect(typeof backend.events.unwatchSession).toBe('function')
        // Creating performs an authoritative read and starts one stream.
        await waitFor(() => countFor(session.id) === 1, 'creating a session follows it exactly once')
        backend.events.unwatchSession?.(session.id)
        policy.attach(backend)
        await settle(500)
        // Reading directory/Job metadata must not replay idle session history.
        expect(countFor(session.id)).toBe(1)

        policy.surfaceDisplaysSession('sidebar', session.id)
        policy.surfaceDisplaysSession('editor', session.id)
        await waitFor(() => countFor(session.id) === 2, 'displaying a session must subscribe again')
        policy.surfaceVisibilityChanged('sidebar', false)
        await settle(400)
        backend.events.watchSession?.(session.id)
        await settle(200)
        expect(countFor(session.id)).toBe(2)

        policy.surfaceVisibilityChanged('editor', false)
        await settle(500)
        policy.surfaceVisibilityChanged('editor', true)
        await waitFor(() => countFor(session.id) === 3, 'showing a released hidden tab must resubscribe')

        // The normal open path re-baselines the follow stream as well.
        await backend.sessions.open?.(session.id)
        await waitFor(() => countFor(session.id) === 4, 'opening must re-baseline the follow stream')
      } finally {
        policy.dispose()
        unsubscribe()
        await runtime.stop()
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
