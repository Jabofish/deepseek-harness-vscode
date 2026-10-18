import { describe, expect, it, vi } from 'vitest'
import type { ProtocolClient } from '../protocol-client.js'
import { createAppLifecycleActions } from './app-lifecycle-actions.js'

describe('connection startup priority', () => {
  it.each([false, true])(
    'starts ready before update inspection and still checks updates after failure=%s',
    async (failed) => {
      let finish: (() => void) | undefined
      const pending = new Promise<void>((resolve, reject) => {
        finish = () => (failed ? reject(new Error('Connection unavailable')) : resolve())
      })
      const events: string[] = []
      const request = vi.fn(() => {
        events.push('ready')
        return pending
      })
      const updates = vi.fn(() => {
        events.push('updates')
        return Promise.resolve(undefined)
      })
      const refresh = vi.fn(() => {
        events.push('refresh')
        return Promise.resolve()
      })
      const restore = vi.fn(() => {
        events.push('restore')
        return Promise.resolve()
      })
      const actions = createAppLifecycleActions({
        client: { request } as unknown as ProtocolClient,
        checkDshUpdates: updates,
        applyBusyEnterPreference: () => Promise.resolve(),
        attemptStartupRestore: restore,
        isEditorSurface: () => false,
        invalidateFeedback: () => undefined,
        markStartupRestoreArmed: () => undefined,
        refresh,
      })
      const initializing = actions.initialize()
      const settled = failed
        ? expect(initializing).rejects.toThrow('Connection unavailable')
        : expect(initializing).resolves.toBeUndefined()
      expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'app.ready' }))
      expect(updates).not.toHaveBeenCalled()
      finish?.()
      await settled
      expect(events).toEqual(failed ? ['ready', 'updates'] : ['ready', 'refresh', 'restore', 'updates'])
    },
  )
})
