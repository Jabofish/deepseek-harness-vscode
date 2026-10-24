import { describe, expect, it, vi } from 'vitest'
import type { DshUpdateSnapshot } from '@dsh-vscode/domain'
import type { ProtocolClient } from '../protocol-client.js'
import { createDshUpdateActions } from './dsh-update.js'
import { createInitialState } from './initial-state.js'
import type { AppState } from './types.js'
import { applyHostMessage } from './host-message-reducers.js'

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
} {
  let state: AppState = { ...createInitialState({}), dshUpdate: snapshot }
  const request = vi.fn<ProtocolClient['request']>()
  const actions = createDshUpdateActions({
    client: { request } as unknown as ProtocolClient,
    setState: (update) => {
      state = typeof update === 'function' ? update(state) : update
    },
  })
  return {
    actions,
    request,
    getState: () => state,
    connected: (version: string) => {
      state = { ...state, connectedDshVersion: version }
    },
  }
}

describe('runtime update state', () => {
  it('receives verified installation results from another chat surface', () => {
    let state: AppState = { ...createInitialState({}), connectedDshVersion: '0.2.1-rc.2' }
    applyHostMessage(
      {
        type: 'event',
        name: 'runtime.update.progress',
        sequence: 1,
        payload: { phase: 'completed', version: '0.2.1-rc.3', snapshot },
      },
      state,
      (update) => {
        state = typeof update === 'function' ? update(state) : update
      },
    )
    expect(state.dshUpdate).toMatchObject({
      globalVersion: '0.2.1-rc.3',
      currentVersion: '0.2.1-rc.2',
      restartRequired: true,
    })
  })
  it('refreshes the running version immediately when the replacement DSH connects', () => {
    let state: AppState = { ...createInitialState({}), dshUpdate: snapshot }
    applyHostMessage(
      {
        type: 'event',
        name: 'connection.snapshot',
        sequence: 2,
        payload: { kind: 'connected', dshVersion: '0.2.1-rc.3' },
      },
      state,
      (update) => {
        state = typeof update === 'function' ? update(state) : update
      },
    )
    expect(state.dshUpdate).toMatchObject({ currentVersion: '0.2.1-rc.3', restartRequired: false })
  })
  it('rejects a delayed check overwriting a newer install and keeps the connected version after reconnect', async () => {
    const h = harness()
    let release!: (value: unknown) => void
    h.request
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      )
      .mockResolvedValueOnce(snapshot)
    const old = h.actions.checkDshUpdates(true)
    h.connected('0.2.1-rc.3')
    await h.actions.installDshVersion('0.2.1-rc.3')
    release({ ...snapshot, globalVersion: '0.2.1-rc.2', updateAvailable: true })
    await old
    expect(h.getState().dshUpdate).toMatchObject({
      currentVersion: '0.2.1-rc.3',
      globalVersion: '0.2.1-rc.3',
      restartRequired: false,
      updateAvailable: false,
    })
  })

  it('shares an install, rejects a competing version and clears stale status on failure', async () => {
    const h = harness()
    let reject!: (error: Error) => void
    h.request.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        }),
    )
    const installation = h.actions.installDshVersion('0.2.1-rc.3')
    expect(h.actions.installDshVersion('0.2.1-rc.3')).toBe(installation)
    await expect(h.actions.installDshVersion('0.2.1-rc.2')).rejects.toThrow('already running')
    reject(new Error('network failed'))
    await expect(installation).rejects.toThrow('network failed')
    expect(h.getState().dshUpdate).toBeUndefined()
    expect(h.getState().dshUpdateProgress?.phase).toBe('failed')
    h.request.mockResolvedValueOnce(snapshot)
    await h.actions.checkDshUpdates(true)
    expect(h.getState().dshUpdate).toEqual(snapshot)
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
