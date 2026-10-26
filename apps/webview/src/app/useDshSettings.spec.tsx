// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AppStore, DshSettingsSnapshot } from './store.js'
import type { AppState } from './store.js'
import { useDshSettings } from './useDshSettings.js'

/**
 * The generation-fencing contract of the settings hook, tested at its own
 * layer. App.connected.spec.tsx keeps only the cases that need a second
 * surface (Composer send, preset selection) on top of these guarantees.
 */

type SettingsState = Pick<
  AppState,
  'backend' | 'connectedDshVersion' | 'connectionEpoch' | 'presetSelectionEnabled'
>

function connectedState(overrides: Partial<SettingsState> = {}): SettingsState {
  return {
    backend: { kind: 'connected' },
    connectedDshVersion: '0.2.1-rc.3',
    connectionEpoch: 1,
    presetSelectionEnabled: true,
    ...overrides,
  }
}

function dshUiSettingsSnapshot(enabled?: boolean, busyEnter?: 'queue' | 'steer'): DshSettingsSnapshot {
  const fields: DshSettingsSnapshot['schema']['fields'][number][] = []
  const values: Record<string, unknown> = {}
  if (enabled !== undefined) {
    fields.push({
      path: 'ui-settings.enabled',
      label: 'enabled',
      type: 'boolean',
      required: false,
      restartRequired: false,
    })
    values['ui-settings'] = { enabled }
  }
  if (busyEnter !== undefined) {
    fields.push({
      path: 'ui-conversation.busyEnter',
      label: 'busyEnter',
      type: 'enum',
      required: false,
      enumValues: ['queue', 'steer'],
      restartRequired: false,
    })
    values['ui-conversation'] = { busyEnter }
  }
  return {
    schema: {
      version: 'rc2-settings-v1',
      writable: true,
      hasDocument: false,
      fields,
      namespaces: [
        ...(enabled === undefined
          ? []
          : [
              {
                ns: 'ui-settings',
                applies: 'live' as const,
                revision: 1,
                userFields: ['enabled'],
                secrets: [],
              },
            ]),
        ...(busyEnter === undefined
          ? []
          : [
              {
                ns: 'ui-conversation',
                applies: 'live' as const,
                revision: 1,
                userFields: ['busyEnter'],
                secrets: [],
              },
            ]),
      ],
    },
    values,
  }
}

interface SettingsHarness {
  readonly result: { readonly current: ReturnType<typeof useDshSettings> }
  readonly readDshSettings: ReturnType<typeof vi.fn>
  readonly updateDshSetting: ReturnType<typeof vi.fn>
  /** Publish the next Host generation to the hook, like a store update in App. */
  readonly setState: (next: SettingsState) => void
}

function setupSettings(
  initialState: SettingsState,
  overrides: { readDshSettings?: ReturnType<typeof vi.fn>; updateDshSetting?: ReturnType<typeof vi.fn> } = {},
): SettingsHarness {
  let state = initialState
  const readDshSettings = overrides.readDshSettings ?? vi.fn().mockResolvedValue(dshUiSettingsSnapshot())
  const updateDshSetting = overrides.updateDshSetting ?? vi.fn().mockResolvedValue(undefined)
  // Created once so identities stay stable across renders, like the memoized
  // callbacks production receives from useI18n and App handlers.
  const adoptLocaleFromHost = vi.fn()
  const setLocale = vi.fn()
  const setThemePreferenceState = vi.fn()
  const setError = vi.fn()
  const t = vi.fn((key: string): string => key)
  const store = { getState: () => state, readDshSettings, updateDshSetting } as unknown as AppStore
  const hook = renderHook(
    ({ state }: { state: SettingsState }) =>
      useDshSettings({
        store,
        state,
        adoptLocaleFromHost,
        setLocale,
        setThemePreferenceState,
        setError,
        t,
      }),
    { initialProps: { state } },
  )
  return {
    result: hook.result,
    readDshSettings,
    updateDshSetting,
    setState(next: SettingsState): void {
      state = next
      hook.rerender({ state: next })
    },
  }
}

describe('useDshSettings generation fencing', () => {
  it('keeps Developer Tools surfaces gated until a snapshot is accepted and after a failed read', async () => {
    let resolveSettings: ((snapshot: DshSettingsSnapshot) => void) | undefined
    const pendingSettings = new Promise<DshSettingsSnapshot>((resolve) => {
      resolveSettings = resolve
    })
    const readDshSettings = vi
      .fn()
      .mockReturnValueOnce(pendingSettings)
      .mockRejectedValue(new Error('offline'))
    const settings = setupSettings(connectedState(), { readDshSettings })

    // While the first read is in flight nothing is trusted yet.
    expect(settings.result.current.codingToolsEnabled).toBe(false)
    expect(settings.result.current.readyDshUiPreferences).toBeUndefined()

    await act(async () => {
      resolveSettings?.(dshUiSettingsSnapshot(true))
      await pendingSettings
    })
    await waitFor(() => expect(settings.result.current.codingToolsEnabled).toBe(true))

    // A new connection generation whose read fails falls back to the closed gate.
    settings.setState(connectedState({ connectionEpoch: 2 }))
    await act(async () => {
      await expect(settings.result.current.readDshSettingsForUi()).rejects.toThrow('offline')
    })
    await waitFor(() => expect(settings.result.current.codingToolsEnabled).toBe(false))
    expect(settings.result.current.readyDshUiPreferences).toBeUndefined()
  })

  it('never lets a previous-generation write, resolved or refused, change the new Host settings', async () => {
    // A previous connection's write must leave the new Host's preferences intact.
    {
      let resolveOldWrite: () => void = () => undefined
      const oldWrite = new Promise<void>((resolve) => {
        resolveOldWrite = resolve
      })
      let busyEnter: 'queue' | 'steer' = 'queue'
      const readDshSettings = vi.fn(() => Promise.resolve(dshUiSettingsSnapshot(true, busyEnter)))
      const updateDshSetting = vi.fn().mockReturnValue(oldWrite)
      const settings = setupSettings(connectedState({ connectionEpoch: 20 }), {
        readDshSettings,
        updateDshSetting,
      })

      await waitFor(() => expect(settings.result.current.codingToolsEnabled).toBe(true))
      const write = settings.result.current.updateDshSettingFromDrawer('ui-settings.enabled', false, 1)
      busyEnter = 'steer'
      settings.setState(connectedState({ connectionEpoch: 21 }))
      await waitFor(() => expect(settings.result.current.readyDshUiPreferences?.busyEnter).toBe('steer'))

      await act(async () => {
        resolveOldWrite()
        await write
      })
      expect(settings.result.current.codingToolsEnabled).toBe(true)
      expect(settings.result.current.readyDshUiPreferences?.busyEnter).toBe('steer')
    }

    // A refused previous-generation write must not disturb the new generation either.
    {
      let rejectOldWrite: (reason: Error) => void = () => undefined
      const oldWrite = new Promise<void>((_resolve, reject) => {
        rejectOldWrite = reject
      })
      let busyEnter: 'queue' | 'steer' = 'queue'
      const readDshSettings = vi.fn(() => Promise.resolve(dshUiSettingsSnapshot(true, busyEnter)))
      const updateDshSetting = vi.fn().mockReturnValue(oldWrite)
      const settings = setupSettings(connectedState({ connectionEpoch: 30 }), {
        readDshSettings,
        updateDshSetting,
      })

      await waitFor(() => expect(settings.result.current.codingToolsEnabled).toBe(true))
      const write = settings.result.current
        .updateDshSettingFromDrawer('ui-settings.enabled', false, 1)
        .catch(() => undefined)
      busyEnter = 'steer'
      settings.setState(connectedState({ connectionEpoch: 31 }))
      await waitFor(() => expect(settings.result.current.readyDshUiPreferences?.busyEnter).toBe('steer'))

      await act(async () => {
        rejectOldWrite(new Error('previous Host refused the update'))
        await write
      })
      expect(settings.result.current.codingToolsEnabled).toBe(true)
      expect(settings.result.current.readyDshUiPreferences?.busyEnter).toBe('steer')
    }
  })
})
