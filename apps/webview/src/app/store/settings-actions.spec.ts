import { describe, expect, it, vi } from 'vitest'
import type { ProtocolClient } from '../protocol-client.js'
import { createSettingsActions } from './settings-actions.js'
import type { AppState, StateSetter } from './types.js'

function harness(initial: Partial<AppState>): {
  readonly actions: ReturnType<typeof createSettingsActions>
  readonly request: ReturnType<typeof vi.fn>
  readonly state: () => AppState
  readonly setState: StateSetter
} {
  let state = initial as AppState
  const setState: StateSetter = (next) => {
    state = typeof next === 'function' ? next(state) : next
  }
  const request = vi.fn().mockResolvedValue({})
  const actions = createSettingsActions({
    client: { request } as unknown as ProtocolClient,
    getState: () => state,
    setState,
    refreshModelCatalog: () => Promise.resolve(),
    applyBusyEnter: () => undefined,
    nextPresetRosterGeneration: () => 0,
    isPresetRosterCurrent: () => true,
  })
  return { actions, request, state: () => state, setState }
}

describe('permission default write', () => {
  it('makes an accepted permission.defaultPreset the new-session default', async () => {
    const { actions, state } = harness({
      newSessionPermissionPresets: ['read-only', 'workspace-write', 'auto'],
      newSessionPermissionDefault: 'workspace-write',
      newSessionPermissionDefaultOptions: ['read-only', 'workspace-write'],
    })
    await actions.updateDshSetting('permission.defaultPreset', 'read-only', 3)
    expect(state().newSessionPermissionDefault).toBe('read-only')
  })

  it('keeps the default when the write fails or names an unoffered preset', async () => {
    const failing = harness({
      newSessionPermissionDefault: 'workspace-write',
      newSessionPermissionDefaultOptions: ['read-only', 'workspace-write'],
    })
    failing.request.mockRejectedValueOnce(new Error('conflict'))
    await expect(
      failing.actions.updateDshSetting('permission.defaultPreset', 'read-only', 3),
    ).rejects.toThrow()
    expect(failing.state().newSessionPermissionDefault).toBe('workspace-write')
    const unoffered = harness({
      newSessionPermissionDefault: 'workspace-write',
      newSessionPermissionDefaultOptions: ['read-only', 'workspace-write'],
    })
    await unoffered.actions.updateDshSetting('permission.defaultPreset', 'auto', 3)
    expect(unoffered.state().newSessionPermissionDefault).toBe('workspace-write')
  })

  it('ignores a permission write completed by a previous connection', async () => {
    const { actions, request, state, setState } = harness({
      connectionEpoch: 1,
      newSessionPermissionDefault: 'workspace-write',
      newSessionPermissionDefaultOptions: ['read-only', 'workspace-write'],
    })
    let finish!: () => void
    request.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)))
    const save = actions.updateDshSetting('permission.defaultPreset', 'read-only', 3)
    setState((current) => ({ ...current, connectionEpoch: 2 }))
    finish()
    await save
    expect(state().newSessionPermissionDefault).toBe('workspace-write')
  })
})
