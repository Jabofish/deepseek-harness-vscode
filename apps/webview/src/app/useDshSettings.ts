import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { AppState, AppStore, DshSettingsSnapshot } from './store.js'
import {
  DSH_UI_SETTING_PATHS,
  dshUiPreferences,
  findDshSettingsField,
  readDshSettingValue,
  rememberThemePreference,
  withDshSettingValue,
  type DshUiPreferences,
  type PerformanceUsageMode,
  type ThemePreference,
  type TranscriptViewMode,
} from './ui-preferences.js'
import { useStableCallback } from './useStableCallback.js'
import type { Locale, Translate } from '../i18n.js'

const DSH_LOCALE_SETTING_PATH = 'locale.preference'
interface AcknowledgedDshSettingWrite {
  readonly path: string
  readonly value: unknown
  readonly expectedRevision: number
}

interface DshSettingsUi {
  readonly adoptExplicitLocaleFromDsh: (value: Locale) => void
  readonly readDshSettingsForUi: () => Promise<DshSettingsSnapshot | undefined>
  readonly updateDshSettingFromDrawer: AppStore['updateDshSetting']
  readonly unsetDshSettingFromDrawer: AppStore['unsetDshSetting']
  readonly mutateDshSettingsFromDrawer: AppStore['mutateDshSettings']
  readonly applyLocale: (value: Locale) => void
  readonly readyDshUiPreferences: DshUiPreferences | undefined
  readonly settingsDrawerVersionKey: string
  readonly codingToolsEnabled: boolean
  readonly newSessionPresetSelectionEnabled: boolean | undefined
  readonly transcriptView: TranscriptViewMode
  readonly performanceUsage: PerformanceUsageMode
  readonly hostConversationFontSizePx: number | undefined
  readonly conversationFontStyle: CSSProperties | undefined
}

export function useDshSettings(input: {
  readonly store: AppStore
  readonly state: Pick<
    AppState,
    'backend' | 'connectedDshVersion' | 'connectionEpoch' | 'presetSelectionEnabled'
  >
  readonly adoptLocaleFromHost: (value: unknown, hasExplicitPreference: boolean) => void
  readonly setLocale: (locale: Locale) => void
  readonly setThemePreferenceState: (theme: ThemePreference) => void
  readonly setConversationView: (view: 'chat' | 'trajectory') => void
  readonly setError: (message: string | undefined) => void
  readonly t: Translate
}): DshSettingsUi {
  const {
    store,
    state,
    adoptLocaleFromHost,
    setLocale,
    setThemePreferenceState,
    setConversationView,
    setError,
    t,
  } = input
  const [dshSettingsSnapshot, setDshSettingsSnapshot] = useState<DshSettingsSnapshot | undefined>()
  const [dshSettingsSnapshotVersion, setDshSettingsSnapshotVersion] = useState<string | undefined>()
  const [dshSettingsSnapshotConnectionEpoch, setDshSettingsSnapshotConnectionEpoch] = useState<
    number | undefined
  >()
  const dshSettingsSnapshotRef = useRef<DshSettingsSnapshot | undefined>(undefined)
  const dshSettingsSnapshotVersionRef = useRef<string | undefined>(undefined)
  const dshSettingsReadSequenceRef = useRef(0)
  const dshSettingsAcceptedReadSequenceRef = useRef(0)
  const dshSettingsWriteSequenceRef = useRef(0)
  const dshSettingsWritesPendingRef = useRef(0)
  const dshSettingsSnapshotMustRefreshRef = useRef(false)
  const dshSettingsCommittedValuePendingRefreshRef = useRef(false)
  const dshSettingsVersionEpochRef = useRef(0)
  const dshSettingsTrackedConnectedRef = useRef(false)
  const dshSettingsTrackedVersionRef = useRef<string | undefined>(undefined)
  const dshSettingsTrackedConnectionEpochRef = useRef<number | undefined>(undefined)
  const [dshSettingsReadState, setDshSettingsReadState] = useState<'loading' | 'unavailable' | 'ready'>(
    'loading',
  )
  const adoptExplicitLocaleFromDsh = useCallback(
    (value: Locale): void => adoptLocaleFromHost(value, true),
    [adoptLocaleFromHost],
  )

  const adoptDshSettingsSnapshot = useCallback(
    (snapshot: DshSettingsSnapshot): void => {
      const connectionEpoch = state.connectionEpoch ?? 0
      dshSettingsCommittedValuePendingRefreshRef.current = false
      dshSettingsSnapshotRef.current = snapshot
      dshSettingsSnapshotVersionRef.current = state.connectedDshVersion
      setDshSettingsSnapshot(snapshot)
      setDshSettingsSnapshotVersion(state.connectedDshVersion)
      setDshSettingsSnapshotConnectionEpoch(connectionEpoch)
      setDshSettingsReadState('ready')
      const preferences = dshUiPreferences(snapshot)
      const localeField = findDshSettingsField(snapshot, DSH_LOCALE_SETTING_PATH)
      const hostLocale = readDshSettingValue(snapshot.values, DSH_LOCALE_SETTING_PATH)
      adoptLocaleFromHost(hostLocale, localeField?.type === 'string' && typeof hostLocale === 'string')
      const hostTheme = preferences.theme
      if (hostTheme !== undefined) {
        setThemePreferenceState(hostTheme)
        rememberThemePreference(hostTheme)
      }
      if (preferences.codingToolsEnabled === false) setConversationView('chat')
    },
    [
      adoptLocaleFromHost,
      setConversationView,
      setThemePreferenceState,
      state.connectedDshVersion,
      state.connectionEpoch,
    ],
  )

  const readDshSettingsForUi = useStableCallback(async (): Promise<DshSettingsSnapshot | undefined> => {
    const readSequence = ++dshSettingsReadSequenceRef.current
    const writeSequence = dshSettingsWriteSequenceRef.current
    const versionEpoch = dshSettingsVersionEpochRef.current
    const startedDuringWrite = dshSettingsWritesPendingRef.current > 0
    const requestedVersion = state.connectedDshVersion
    const requestedConnectionEpoch = state.connectionEpoch ?? 0
    let snapshot: DshSettingsSnapshot | undefined
    try {
      snapshot = await store.readDshSettings()
    } catch (reason: unknown) {
      if (dshSettingsSnapshotMustRefreshRef.current && !dshSettingsCommittedValuePendingRefreshRef.current) {
        dshSettingsSnapshotRef.current = undefined
        dshSettingsSnapshotVersionRef.current = undefined
        setDshSettingsSnapshot(undefined)
        setDshSettingsSnapshotVersion(undefined)
        setDshSettingsSnapshotConnectionEpoch(undefined)
        setDshSettingsReadState('unavailable')
      }
      throw reason
    }
    const currentState = store.getState()
    if (
      currentState.backend.kind !== 'connected' ||
      currentState.connectedDshVersion !== requestedVersion ||
      (currentState.connectionEpoch ?? 0) !== requestedConnectionEpoch ||
      dshSettingsTrackedConnectionEpochRef.current !== requestedConnectionEpoch ||
      dshSettingsVersionEpochRef.current !== versionEpoch ||
      readSequence < dshSettingsAcceptedReadSequenceRef.current ||
      writeSequence !== dshSettingsWriteSequenceRef.current ||
      startedDuringWrite ||
      dshSettingsWritesPendingRef.current > 0
    )
      return undefined
    dshSettingsAcceptedReadSequenceRef.current = readSequence
    if (snapshot !== undefined) {
      dshSettingsSnapshotMustRefreshRef.current = false
      adoptDshSettingsSnapshot(snapshot)
    } else if (
      dshSettingsSnapshotMustRefreshRef.current &&
      !dshSettingsCommittedValuePendingRefreshRef.current
    ) {
      dshSettingsSnapshotRef.current = undefined
      dshSettingsSnapshotVersionRef.current = undefined
      setDshSettingsSnapshot(undefined)
      setDshSettingsSnapshotVersion(undefined)
      setDshSettingsSnapshotConnectionEpoch(undefined)
      setDshSettingsReadState('unavailable')
    } else if (dshSettingsSnapshotRef.current === undefined) setDshSettingsReadState('unavailable')
    return snapshot
  })

  const recordAcknowledgedDshSettingWrite = useStableCallback(
    (
      write: AcknowledgedDshSettingWrite,
      snapshotAtStart: DshSettingsSnapshot | undefined,
      versionAtStart: string | undefined,
      connectionEpochAtStart: number,
      versionEpochAtStart: number,
    ): void => {
      const currentState = store.getState()
      const namespace = write.path.split('.', 1)[0]
      if (
        snapshotAtStart === undefined ||
        dshSettingsSnapshotRef.current !== snapshotAtStart ||
        namespace === undefined ||
        currentState.backend.kind !== 'connected' ||
        currentState.connectedDshVersion !== versionAtStart ||
        (currentState.connectionEpoch ?? 0) !== connectionEpochAtStart ||
        dshSettingsTrackedConnectionEpochRef.current !== connectionEpochAtStart ||
        dshSettingsVersionEpochRef.current !== versionEpochAtStart ||
        snapshotAtStart.schema.namespaces.find((entry) => entry.ns === namespace)?.revision !==
          write.expectedRevision
      )
        return
      const accepted = withDshSettingValue(snapshotAtStart, write.path, write.value)
      if (accepted === undefined) return
      dshSettingsCommittedValuePendingRefreshRef.current = true
      dshSettingsSnapshotRef.current = accepted
      dshSettingsSnapshotVersionRef.current = versionAtStart
      setDshSettingsSnapshot(accepted)
      setDshSettingsSnapshotVersion(versionAtStart)
      setDshSettingsSnapshotConnectionEpoch(connectionEpochAtStart)
      setDshSettingsReadState('ready')
    },
  )

  const writeDshSettingsForUi = useStableCallback(
    async (write: () => Promise<void>, acknowledgedWrite?: AcknowledgedDshSettingWrite): Promise<void> => {
      const versionAtStart = state.connectedDshVersion
      const connectionEpochAtStart = state.connectionEpoch ?? 0
      const versionEpochAtStart = dshSettingsVersionEpochRef.current
      const snapshotAtStart = dshSettingsSnapshotRef.current
      dshSettingsWriteSequenceRef.current += 1
      dshSettingsWritesPendingRef.current += 1
      dshSettingsSnapshotMustRefreshRef.current = true
      let writeFailure: unknown
      try {
        await write()
      } catch (reason: unknown) {
        writeFailure = reason
      } finally {
        const currentState = store.getState()
        if (
          currentState.backend.kind === 'connected' &&
          currentState.connectedDshVersion === versionAtStart &&
          (currentState.connectionEpoch ?? 0) === connectionEpochAtStart &&
          dshSettingsTrackedConnectionEpochRef.current === connectionEpochAtStart &&
          dshSettingsVersionEpochRef.current === versionEpochAtStart
        ) {
          dshSettingsWritesPendingRef.current = Math.max(0, dshSettingsWritesPendingRef.current - 1)
        }
      }
      const currentState = store.getState()
      const sameConnection =
        currentState.backend.kind === 'connected' &&
        currentState.connectedDshVersion === versionAtStart &&
        (currentState.connectionEpoch ?? 0) === connectionEpochAtStart &&
        dshSettingsTrackedConnectionEpochRef.current === connectionEpochAtStart &&
        dshSettingsVersionEpochRef.current === versionEpochAtStart
      if (!sameConnection) {
        if (writeFailure !== undefined)
          throw writeFailure instanceof Error ? writeFailure : new Error(t('settings.updateFailed'))
        return
      }
      if (writeFailure === undefined && acknowledgedWrite !== undefined)
        recordAcknowledgedDshSettingWrite(
          acknowledgedWrite,
          snapshotAtStart,
          versionAtStart,
          connectionEpochAtStart,
          versionEpochAtStart,
        )
      const refreshed = await readDshSettingsForUi().catch(() => undefined)
      if (refreshed === undefined && !dshSettingsCommittedValuePendingRefreshRef.current) {
        dshSettingsSnapshotRef.current = undefined
        dshSettingsSnapshotVersionRef.current = undefined
        setDshSettingsSnapshot(undefined)
        setDshSettingsSnapshotVersion(undefined)
        setDshSettingsSnapshotConnectionEpoch(undefined)
        setDshSettingsReadState('unavailable')
      }
      if (writeFailure !== undefined)
        throw writeFailure instanceof Error ? writeFailure : new Error(t('settings.updateFailed'))
    },
  )

  const trackDshSettingsWriteForUi = useStableCallback(
    async (write: () => Promise<void>, acknowledgedWrite?: AcknowledgedDshSettingWrite): Promise<void> => {
      const versionAtStart = state.connectedDshVersion
      const connectionEpochAtStart = state.connectionEpoch ?? 0
      const versionEpochAtStart = dshSettingsVersionEpochRef.current
      const snapshotAtStart = dshSettingsSnapshotRef.current
      dshSettingsWriteSequenceRef.current += 1
      dshSettingsWritesPendingRef.current += 1
      dshSettingsSnapshotMustRefreshRef.current = true
      try {
        await write()
        if (acknowledgedWrite !== undefined)
          recordAcknowledgedDshSettingWrite(
            acknowledgedWrite,
            snapshotAtStart,
            versionAtStart,
            connectionEpochAtStart,
            versionEpochAtStart,
          )
      } finally {
        const currentState = store.getState()
        if (
          currentState.backend.kind === 'connected' &&
          currentState.connectedDshVersion === versionAtStart &&
          (currentState.connectionEpoch ?? 0) === connectionEpochAtStart &&
          dshSettingsTrackedConnectionEpochRef.current === connectionEpochAtStart &&
          dshSettingsVersionEpochRef.current === versionEpochAtStart
        ) {
          dshSettingsWritesPendingRef.current = Math.max(0, dshSettingsWritesPendingRef.current - 1)
        }
      }
    },
  )

  const updateDshSettingForUi = useStableCallback(
    async (path: string, value: unknown, expectedRevision: number): Promise<void> =>
      writeDshSettingsForUi(() => store.updateDshSetting(path, value, expectedRevision), {
        path,
        value,
        expectedRevision,
      }),
  )
  const updateDshSettingFromDrawer = useStableCallback(
    async (path: string, value: unknown, expectedRevision: number): Promise<void> =>
      trackDshSettingsWriteForUi(() => store.updateDshSetting(path, value, expectedRevision), {
        path,
        value,
        expectedRevision,
      }),
  )
  const unsetDshSettingFromDrawer = useStableCallback(
    async (path: string, expectedRevision: number): Promise<void> =>
      trackDshSettingsWriteForUi(() => store.unsetDshSetting(path, expectedRevision)),
  )
  const mutateDshSettingsFromDrawer = useStableCallback(
    async (
      namespace: string,
      operations: Parameters<typeof store.mutateDshSettings>[1],
      expectedRevision: number,
    ): Promise<void> =>
      trackDshSettingsWriteForUi(() => store.mutateDshSettings(namespace, operations, expectedRevision)),
  )

  useLayoutEffect(() => {
    const connected = state.backend.kind === 'connected'
    const wasConnected = dshSettingsTrackedConnectedRef.current
    dshSettingsTrackedConnectedRef.current = connected
    if (!connected) {
      if (wasConnected) {
        // Invalidate every outstanding settings read before it can adopt data
        // from the disconnected Host into the local/editor fallback state.
        dshSettingsVersionEpochRef.current += 1
        dshSettingsWritesPendingRef.current = 0
        dshSettingsSnapshotMustRefreshRef.current = false
        dshSettingsCommittedValuePendingRefreshRef.current = false
        adoptLocaleFromHost(undefined, false)
      }
      return
    }
    const previousVersion = dshSettingsTrackedVersionRef.current
    const previousConnectionEpoch = dshSettingsTrackedConnectionEpochRef.current
    const currentConnectionEpoch = state.connectionEpoch ?? 0
    dshSettingsTrackedVersionRef.current = state.connectedDshVersion
    dshSettingsTrackedConnectionEpochRef.current = currentConnectionEpoch
    if (!wasConnected) {
      // Treat reconnection as a fresh Host generation even if its version tag
      // matches the previous process.
      dshSettingsVersionEpochRef.current += 1
    } else if (previousConnectionEpoch !== currentConnectionEpoch) {
      // A connected snapshot with a new backend identity is a new Host even
      // when its reported DSH version is unchanged.
      dshSettingsVersionEpochRef.current += 1
    } else if (previousVersion !== state.connectedDshVersion) {
      dshSettingsVersionEpochRef.current += 1
    } else {
      return
    }
    dshSettingsWritesPendingRef.current = 0
    dshSettingsSnapshotMustRefreshRef.current = false
    dshSettingsCommittedValuePendingRefreshRef.current = false
    adoptLocaleFromHost(undefined, false)
    dshSettingsSnapshotRef.current = undefined
    dshSettingsSnapshotVersionRef.current = undefined
    setDshSettingsSnapshot(undefined)
    setDshSettingsSnapshotVersion(undefined)
    setDshSettingsReadState('loading')
  }, [adoptLocaleFromHost, state.backend.kind, state.connectedDshVersion, state.connectionEpoch])

  useEffect(() => {
    if (state.backend.kind !== 'connected') return
    if (dshSettingsSnapshotRef.current === undefined) setDshSettingsReadState('loading')
    let cancelled = false
    void readDshSettingsForUi().catch(() => {
      if (!cancelled && dshSettingsSnapshotRef.current === undefined) setDshSettingsReadState('unavailable')
    })
    return () => {
      cancelled = true
    }
  }, [
    adoptLocaleFromHost,
    readDshSettingsForUi,
    state.backend.kind,
    state.connectedDshVersion,
    state.connectionEpoch,
  ])

  const settingsSnapshotMatchesConnection =
    (state.connectedDshVersion === undefined || dshSettingsSnapshotVersion === state.connectedDshVersion) &&
    dshSettingsSnapshotConnectionEpoch === (state.connectionEpoch ?? 0)
  const currentDshSettingsReady =
    dshSettingsReadState === 'ready' && settingsSnapshotMatchesConnection && dshSettingsSnapshot !== undefined
  const readyDshSettings = currentDshSettingsReady ? dshSettingsSnapshot : undefined
  const readyDshUiPreferences =
    readyDshSettings === undefined ? undefined : dshUiPreferences(readyDshSettings)
  const settingsDrawerVersionKey = `${state.connectedDshVersion ?? dshSettingsSnapshotVersion ?? 'unknown-dsh-version'}:${state.connectionEpoch ?? 0}`
  const codingToolsField =
    readyDshSettings === undefined
      ? undefined
      : findDshSettingsField(readyDshSettings, DSH_UI_SETTING_PATHS.codingTools)
  const codingToolsFieldSupported = codingToolsField?.type === 'boolean'
  const codingToolsEnabled = !currentDshSettingsReady
    ? false
    : codingToolsFieldSupported
      ? (readyDshUiPreferences?.codingToolsEnabled ?? false)
      : codingToolsField === undefined
        ? true
        : false
  const newSessionPresetSelectionEnabled = !currentDshSettingsReady
    ? false
    : codingToolsFieldSupported
      ? codingToolsEnabled
      : codingToolsField === undefined
        ? state.presetSelectionEnabled
        : false
  const transcriptView = readyDshUiPreferences?.transcriptView ?? 'standard'
  const performanceUsage = readyDshUiPreferences?.performanceUsage ?? 'detailed'
  const hostConversationFontSizePx = readyDshUiPreferences?.fontSize
  const conversationFontStyle =
    hostConversationFontSizePx === undefined
      ? undefined
      : ({
          fontSize: `${hostConversationFontSizePx}px`,
          '--dsh-conversation-font-scale': String(hostConversationFontSizePx / 14),
        } as CSSProperties)

  const applyLocale = useCallback(
    (next: Locale): void => {
      setLocale(next)
      if (state.backend.kind !== 'connected') return
      if (dshSettingsSnapshotMustRefreshRef.current) {
        setError(t('settings.revisionRefreshRequired'))
        return
      }
      const settingsNamespace = DSH_LOCALE_SETTING_PATH.split('.')[0]
      const expectedRevision = dshSettingsSnapshotRef.current?.schema.namespaces.find(
        (entry) => entry.ns === settingsNamespace,
      )?.revision
      if (expectedRevision === undefined) {
        setError(t('settings.updateFailed'))
        return
      }
      void updateDshSettingForUi(DSH_LOCALE_SETTING_PATH, next, expectedRevision).catch((reason: unknown) => {
        // The extension UI remains usable even when an older/read-only DSH
        // cannot persist its matching response-language preference.
        setError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
      })
    },
    [setError, setLocale, state.backend.kind, t, updateDshSettingForUi],
  )

  return {
    adoptExplicitLocaleFromDsh,
    readDshSettingsForUi,
    updateDshSettingFromDrawer,
    unsetDshSettingFromDrawer,
    mutateDshSettingsFromDrawer,
    applyLocale,
    readyDshUiPreferences,
    settingsDrawerVersionKey,
    codingToolsEnabled,
    newSessionPresetSelectionEnabled,
    transcriptView,
    performanceUsage,
    hostConversationFontSizePx,
    conversationFontStyle,
  }
}
