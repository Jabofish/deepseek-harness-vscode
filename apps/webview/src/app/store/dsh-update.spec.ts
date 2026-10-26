import { describe, expect, it, vi } from 'vitest'
import type { DshUpdateSnapshot } from '@dsh-vscode/domain'
import type { ProtocolClient } from '../protocol-client.js'
import { createDshUpdateActions } from './dsh-update.js'
import { createInitialState } from './initial-state.js'
import type { AppState } from './types.js'

const snapshot: DshUpdateSnapshot = {
  status: 'ready',
  currentVersion: '0.2.1-rc.2',
  globalVersion: '0.2.1-rc.3',
  latestVersion: '0.2.1-rc.3',
  availableVersions: ['0.2.1-rc.3', '0.2.1-rc.2'],
  updateAvailable: false,
  checkedAt: '2026-10-24T00:00:00.000Z',
  restartRequired: true,
}

function harness(): {
  actions: ReturnType<typeof createDshUpdateActions>
  request: ReturnType<typeof vi.fn<ProtocolClient['request']>>
  getState: () => AppState
  connected: (version: string) => void
  emit: (message: Parameters<Parameters<ProtocolClient['subscribe']>[0]>[0]) => void
} {
  let state: AppState = { ...createInitialState({}), dshUpdate: snapshot }
  const request = vi.fn<ProtocolClient['request']>()
  let listener: Parameters<ProtocolClient['subscribe']>[0] | undefined
  const actions = createDshUpdateActions({
    client: {
      request: <T>(...args: Parameters<ProtocolClient['request']>) => request(...args) as Promise<T>,
      subscribe: (callback) => {
        listener = callback
        return () => {
          listener = undefined
        }
      },
    },
    setState: (update) => {
      state = typeof update === 'function' ? update(state) : update
    },
  })
  return {
    actions,
    request,
    emit: (message) => listener?.(message),
    getState: () => state,
    connected: (version: string) => {
      state = { ...state, connectedDshVersion: version }
    },
  }
}

describe('runtime update state', () => {
  it('settles a verified completion when the request reply is lost and ignores a later request error', async () => {
    const h = harness()
    let reject!: (error: Error) => void
    h.request.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        }),
    )
    const result = h.actions.installDshVersion('0.2.1-rc.3')
    h.emit({
      type: 'event',
      name: 'runtime.update.progress',
      sequence: 1,
      payload: { phase: 'completed', version: '0.2.1-rc.3', snapshot },
    })
    await expect(result).resolves.toMatchObject({ globalVersion: '0.2.1-rc.3' })
    reject(new Error('late request timeout'))
    await Promise.resolve()
    expect(h.getState().dshUpdateProgress?.phase).toBe('completed')
    expect(h.getState().dshUpdate?.globalVersion).toBe('0.2.1-rc.3')
    h.request.mockResolvedValueOnce(snapshot)
    await h.actions.checkDshUpdates(true)
    expect(h.request).toHaveBeenCalledTimes(2)
  })

  it('does not treat an unverified or unrelated completion as its installation result', async () => {
    const h = harness()
    let resolve!: (value: unknown) => void
    h.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const result = h.actions.installDshVersion('0.2.1-rc.3')
    h.emit({
      type: 'event',
      name: 'runtime.update.progress',
      sequence: 1,
      payload: { phase: 'completed', version: '0.2.1-rc.3' },
    })
    h.emit({
      type: 'event',
      name: 'runtime.update.progress',
      sequence: 2,
      payload: { phase: 'completed', version: '0.2.1-rc.2', snapshot },
    })
    await Promise.resolve()
    expect(h.getState().dshUpdateProgress?.phase).toBe('checking')
    resolve(snapshot)
    await result
  })

  it('settles malformed and unavailable responses instead of leaving a permanent spinner', async () => {
    const h = harness()
    h.request.mockResolvedValueOnce({}).mockResolvedValueOnce({
      ...snapshot,
      status: 'unavailable',
      failure: 'registry-unavailable',
      availableVersions: [],
    })
    await expect(h.actions.checkDshUpdates()).rejects.toThrow('invalid update status')
    expect(h.getState().dshUpdateProgress?.phase).toBe('failed')
    await h.actions.checkDshUpdates()
    expect(h.getState().dshUpdateProgress?.phase).toBe('failed')
  })
})
