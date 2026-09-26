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
    connectedDshVersion: '0.1.0-rc.6',
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
  const setConversationView = vi.fn()
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
        setConversationView,
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
    await waitFor(() => expect(readDshSettings).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(settings.result.current.codingToolsEnabled).toBe(false))
    expect(settings.result.current.readyDshUiPreferences).toBeUndefined()
  })

  it('rereads settings when the backend identity changes at the same DSH version', async () => {
    const readDshSettings = vi.fn().mockResolvedValue(dshUiSettingsSnapshot(true))
    const settings = setupSettings(connectedState(), { readDshSettings })
    await waitFor(() => expect(settings.result.current.codingToolsEnabled).toBe(true))
    const keyBefore = settings.result.current.settingsDrawerVersionKey

    settings.setState(connectedState({ connectionEpoch: 2 }))
    await waitFor(() => expect(readDshSettings).toHaveBeenCalledTimes(2))
    expect(settings.result.current.settingsDrawerVersionKey).not.toBe(keyBefore)
  })

  it('ignores an older connection generation settings read that resolves after the current one', async () => {
    let resolveOldRead: (snapshot: DshSettingsSnapshot) => void = () => undefined
    let resolveCurrentRead: (snapshot: DshSettingsSnapshot) => void = () => undefined
    const oldRead = new Promise<DshSettingsSnapshot>((resolve) => {
      resolveOldRead = resolve
    })
    const currentRead = new Promise<DshSettingsSnapshot>((resolve) => {
      resolveCurrentRead = resolve
    })
    const readDshSettings = vi.fn().mockReturnValueOnce(oldRead).mockReturnValueOnce(currentRead)
    const settings = setupSettings(connectedState({ connectionEpoch: 10 }), { readDshSettings })

    await waitFor(() => expect(readDshSettings).toHaveBeenCalledTimes(1))
    settings.setState(connectedState({ connectionEpoch: 11 }))
    await waitFor(() => expect(readDshSettings).toHaveBeenCalledTimes(2))

    await act(async () => {
      resolveCurrentRead(dshUiSettingsSnapshot(true))
      await currentRead
    })
    await waitFor(() => expect(settings.result.current.codingToolsEnabled).toBe(true))

    await act(async () => {
      resolveOldRead(dshUiSettingsSnapshot(false))
      await oldRead
    })
    expect(settings.result.current.codingToolsEnabled).toBe(true)
  })

  it('never lets a previous-generation write, resolved or refused, change the new Host settings', async () => {
    // A successful write from the previous connection generation must not be
    // acknowledged by the new generation, and it must not add a refresh read.
    {
      let resolveOldWrite: () => void = () => undefined
      const oldWrite = new Promise<void>((resolve) => {
        resolveOldWrite = resolve
      })
      const readDshSettings = vi.fn().mockResolvedValue(dshUiSettingsSnapshot(true))
      const updateDshSetting = vi.fn().mockReturnValue(oldWrite)
      const settings = setupSettings(connectedState({ connectionEpoch: 20 }), {
        readDshSettings,
        updateDshSetting,
      })

      await waitFor(() => expect(settings.result.current.codingToolsEnabled).toBe(true))
      const settled = vi.fn()
      const write = settings.result.current
        .updateDshSettingFromDrawer('ui-settings.enabled', false, 1)
        .then(settled)
      settings.setState(connectedState({ connectionEpoch: 21 }))
      await waitFor(() => expect(readDshSettings).toHaveBeenCalledTimes(2))

      await act(async () => {
        resolveOldWrite()
        await write
      })
      expect(settled).toHaveBeenCalled()
      expect(settings.result.current.codingToolsEnabled).toBe(true)
      expect(readDshSettings).toHaveBeenCalledTimes(2)
    }

    // A refused previous-generation write must not disturb the new generation either.
    {
      let rejectOldWrite: (reason: Error) => void = () => undefined
      const oldWrite = new Promise<void>((_resolve, reject) => {
        rejectOldWrite = reject
      })
      const readDshSettings = vi.fn().mockResolvedValue(dshUiSettingsSnapshot(true))
      const updateDshSetting = vi.fn().mockReturnValue(oldWrite)
      const settings = setupSettings(connectedState({ connectionEpoch: 30 }), {
        readDshSettings,
        updateDshSetting,
      })

      await waitFor(() => expect(settings.result.current.codingToolsEnabled).toBe(true))
      const write = settings.result.current
        .updateDshSettingFromDrawer('ui-settings.enabled', false, 1)
        .catch(() => undefined)
      settings.setState(connectedState({ connectionEpoch: 31 }))
      await waitFor(() => expect(readDshSettings).toHaveBeenCalledTimes(2))

      await act(async () => {
        rejectOldWrite(new Error('previous Host refused the update'))
        await write
      })
      expect(settings.result.current.codingToolsEnabled).toBe(true)
      // The callback is generation-aware, so the refused write adds no refresh read.
      expect(readDshSettings).toHaveBeenCalledTimes(2)
    }
  })

  it('clears the old settings gate after a confirmed DSH version change', async () => {
    let rejectNewVersion: ((reason: Error) => void) | undefined
    const nextVersionRead = new Promise<DshSettingsSnapshot>((_resolve, reject) => {
      rejectNewVersion = reject
    })
    const readDshSettings = vi
      .fn()
      .mockResolvedValueOnce(dshUiSettingsSnapshot(true))
      .mockReturnValueOnce(nextVersionRead)
    const settings = setupSettings(connectedState(), { readDshSettings })
    await waitFor(() => expect(settings.result.current.codingToolsEnabled).toBe(true))

    settings.setState(connectedState({ connectedDshVersion: '0.1.0-rc.7' }))
    await waitFor(() => expect(readDshSettings).toHaveBeenCalledTimes(2))
    act(() => rejectNewVersion?.(new Error('new DSH unavailable')))
    expect(settings.result.current.codingToolsEnabled).toBe(false)
    expect(settings.result.current.readyDshUiPreferences).toBeUndefined()
  })

  it('does not let a pre-write settings read restore the old Developer Tools value', async () => {
    let resolvePreWriteRead: ((snapshot: DshSettingsSnapshot) => void) | undefined
    const preWriteRead = new Promise<DshSettingsSnapshot>((resolve) => {
      resolvePreWriteRead = resolve
    })
    let readCount = 0
    const readDshSettings = vi.fn(() => {
      readCount += 1
      if (readCount === 1) return Promise.resolve(dshUiSettingsSnapshot(true))
      if (readCount === 2) return preWriteRead
      return Promise.reject(new Error('refresh unavailable'))
    })
    const settings = setupSettings(connectedState(), { readDshSettings })
    await waitFor(() => expect(settings.result.current.codingToolsEnabled).toBe(true))

    // A read starts before the write; the accepted write lands while it is in flight.
    void settings.result.current.readDshSettingsForUi()
    await act(async () => {
      await settings.result.current.updateDshSettingFromDrawer('ui-settings.enabled', false, 1)
    })
    await waitFor(() => expect(settings.result.current.codingToolsEnabled).toBe(false))

    await act(async () => {
      resolvePreWriteRead?.(dshUiSettingsSnapshot(true))
      await preWriteRead
    })
    expect(settings.result.current.codingToolsEnabled).toBe(false)
  })

  it('applies a successful Developer Tools setting update to the application gate', async () => {
    let codingToolsEnabled = true
    const readDshSettings = vi
      .fn()
      .mockImplementation(() => Promise.resolve(dshUiSettingsSnapshot(codingToolsEnabled)))
    const updateDshSetting = vi.fn((path: string, value: unknown) => {
      if (path === 'ui-settings.enabled' && typeof value === 'boolean') codingToolsEnabled = value
      return Promise.resolve()
    })
    const settings = setupSettings(connectedState(), { readDshSettings, updateDshSetting })

    await waitFor(() => expect(settings.result.current.codingToolsEnabled).toBe(true))
    await act(async () => {
      await settings.result.current.updateDshSettingFromDrawer('ui-settings.enabled', false, 1)
    })
    await waitFor(() => expect(settings.result.current.codingToolsEnabled).toBe(false))
  })
})
