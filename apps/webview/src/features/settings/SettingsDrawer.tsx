import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import type { ExtensionSettingsSummary, ModelDescriptor } from '@dsh-vscode/domain'
import { dshUiPreferences as readDshUiPreferences, isThemePreference } from '../../app/ui-preferences.js'
import { ModalWrapper } from '../../components/common/PopoverCard.js'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
import { Icon } from '../../ui/Icon.js'
import type { CustomProviderTemplate } from './CustomProviderCard.js'
import { useI18n } from '../../i18n.js'
import { useStableCallback } from '../../app/useStableCallback.js'
import {
  deriveCustomProviderTemplate,
  isAddableProvider,
  isConfiguredProvider,
  isValidGeneralSettingChange,
  namespaceInPath,
  providerRowOrder,
  settingsNamespaceRevision,
} from './provider-helpers.js'
import type { DshSettingsState, RiskPending } from './general-controls.js'
import { dshUpdateFailureMessage } from './update-labels.js'
import { isLocale, settingValueAt, withSettingValue } from './settings-values.js'
import { ModelsSettingsTab } from './ModelsSettingsTab.js'
import { GeneralSettingsTab } from './GeneralSettingsTab.js'
import { PluginsSettingsTab, PresetsSettingsTab } from './OtherSettingsTabs.js'
import type { SettingsDrawerProps } from './settings-drawer-props.js'
import { useProviderSettingsFlows } from './provider-settings-flows.js'
import { SettingsTabs } from './settings-tabs.js'

export type { SettingsDrawerProps } from './settings-drawer-props.js'

/**
 * 'unchanged' is not a mode: it marks attach-only/new-isolated settings this
 * page cannot represent. Nothing is pre-selected and Apply stays disabled, so
 * applying can never silently rewrite those modes to 'auto'.
 */
type ConnectionChoice = 'auto' | 'custom' | 'unchanged'

interface LoadedSettings {
  readonly value: ExtensionSettingsSummary | undefined
}

export function SettingsDrawer(props: SettingsDrawerProps): ReactElement {
  const { t } = useI18n()
  const { onLoadAccountDetails, onAcknowledgeAccountBonus, onOpenAccountPage } = props
  const refreshAccountDetails = useCallback((): void => {
    void onLoadAccountDetails?.()
  }, [onLoadAccountDetails])
  const acknowledgeAccountBonus = useCallback(
    (orderId: string): Promise<boolean> => onAcknowledgeAccountBonus?.(orderId) ?? Promise.resolve(false),
    [onAcknowledgeAccountBonus],
  )
  const openAccountUsage = useCallback((): void => onOpenAccountPage?.('usage'), [onOpenAccountPage])
  const openAccountTopUp = useCallback((): void => onOpenAccountPage?.('top-up'), [onOpenAccountPage])
  const {
    open,
    dshUpdate,
    onCheckDshUpdates,
    onInstallDshVersion,
    onLoadSettings,
    onLoadDshSettings,
    onLocaleFromDsh,
    onThemeChange,
    onUpdateDshSetting,
    onOpenChange,
  } = props
  const [settingsState, setSettingsState] = useState<LoadedSettings | undefined>(undefined)
  const [dshState, setDshState] = useState<DshSettingsState>({ status: 'loading' })
  const [dshSettingsSnapshotFresh, setDshSettingsSnapshotFresh] = useState(false)
  const dshSettingsOpenedRef = useRef(false)
  /**
   * Incremented on every close. Async flows started while the drawer was open
   * capture the generation and discard results that land under a newer one, so
   * a late read or save cannot re-arm the freshness gate behind a closed (or
   * already reopened) drawer. The layout effect advances it synchronously at
   * the close commit, so a continuation can never settle in between.
   */
  const openEpochRef = useRef(0)
  useLayoutEffect(() => {
    if (!open) openEpochRef.current += 1
  }, [open])
  const dshUiPreferences = dshState.status === 'ready' ? readDshUiPreferences(dshState.snapshot) : undefined
  const [savingPath, setSavingPath] = useState<string | undefined>(undefined)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [riskPending, setRiskPending] = useState<RiskPending | undefined>(undefined)
  const [riskAcknowledged, setRiskAcknowledged] = useState(false)
  const [busyField, setBusyField] = useState<string | undefined>(undefined)
  const [documentError, setDocumentError] = useState<string | undefined>(undefined)
  const [keyboardShortcutsError, setKeyboardShortcutsError] = useState<string | undefined>(undefined)
  const [dshUpdateBusy, setDshUpdateBusy] = useState<'check' | 'install' | undefined>(undefined)
  const [dshUpdateError, setDshUpdateError] = useState<string | undefined>(undefined)
  const [selectedDshVersion, setSelectedDshVersion] = useState<string | undefined>(undefined)
  const dshUpdateCheckStarted = useRef(false)
  const [editingProviderId, setEditingProviderId] = useState<string | undefined>(undefined)
  const [addingProviderId, setAddingProviderId] = useState<string | undefined>(undefined)
  const [addingCustomProvider, setAddingCustomProvider] = useState(false)
  const [removingProviderId, setRemovingProviderId] = useState<string | undefined>(undefined)
  const [connectionChoice, setConnectionChoice] = useState<ConnectionChoice>('unchanged')
  const [connectionEndpoint, setConnectionEndpoint] = useState('')
  const [connectionBusy, setConnectionBusy] = useState(false)
  const [connectionError, setConnectionError] = useState<string | undefined>(undefined)
  const [connectionNotice, setConnectionNotice] = useState<string | undefined>(undefined)
  const closeRef = useRef<HTMLButtonElement>(null)
  const sectionRef = useRef<HTMLElement | null>(null)
  const removeDialogRef = useRef<HTMLDivElement | null>(null)

  const retryDshSettings = useStableCallback((): void => {
    const epoch = openEpochRef.current
    void onLoadDshSettings()
      .then((snapshot) => {
        if (openEpochRef.current !== epoch) return
        if (snapshot === undefined) {
          if (dshState.status !== 'ready') setDshState({ status: 'unavailable' })
          setDshSettingsSnapshotFresh(false)
          return
        }
        setDshState({ status: 'ready', snapshot })
        setDshSettingsSnapshotFresh(true)
        setSaveError(undefined)
      })
      .catch(() => {
        if (openEpochRef.current !== epoch) return
        if (dshState.status !== 'ready') setDshState({ status: 'unavailable' })
        setDshSettingsSnapshotFresh(false)
      })
  })

  /** The provider row's control takes the keyboard back from its confirmation. */
  const removeProviderTriggerRef = useRef<HTMLElement | null>(null)
  const removeProviderWasOpen = useRef(false)

  const removeProviderOpen = removingProviderId !== undefined
  useEffect(() => {
    if (removeProviderWasOpen.current && !removeProviderOpen) {
      const target = removeProviderTriggerRef.current
      removeProviderTriggerRef.current = null
      // A confirmed removal deletes the row that opened the confirmation.
      if (target !== null && target.isConnected) target.focus()
    }
    removeProviderWasOpen.current = removeProviderOpen
  }, [removeProviderOpen])

  useEffect(() => {
    // The drawer owns the keyboard once, when it opens. The settings answer
    // below lands later and the App re-renders behind it, so keeping this in
    // the load effect would pull the keyboard back to the close button while
    // the user is already working in a field.
    if (!open) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open || settingsState !== undefined) return
    const epoch = openEpochRef.current
    let cancelled = false
    void onLoadSettings()
      .catch(() => undefined)
      .then((value) => {
        if (cancelled || openEpochRef.current !== epoch) return
        setSettingsState({ value })
        if (value !== undefined) {
          setConnectionChoice(
            value.connection.mode === 'custom' || value.connection.mode === 'auto'
              ? value.connection.mode
              : 'unchanged',
          )
          setConnectionEndpoint('')
          setConnectionError(undefined)
          setConnectionNotice(undefined)
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, onLoadSettings, settingsState])

  // The drawer stays mounted while closed; dropping the cached answer makes
  // the next open re-read extension settings, which can change elsewhere.
  // Adjusting state during render (not in an effect) keeps the closed drawer
  // from painting once with a stale cache.
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (!open) {
      setSettingsState(undefined)
      // DSH settings can change outside this drawer while it is closed.
      // Reopening must re-read them instead of displaying — and saving
      // against — the stale snapshot; the freshness gate below blocks writes
      // until the re-read lands.
      setDshState({ status: 'loading' })
      setDshSettingsSnapshotFresh(false)
    }
  }

  useEffect(() => {
    if (!open) {
      dshSettingsOpenedRef.current = false
      return
    }
    const opened = !dshSettingsOpenedRef.current
    dshSettingsOpenedRef.current = true
    if (!opened && dshState.status !== 'loading') return
    const hadSnapshot = dshState.status === 'ready'
    const epoch = openEpochRef.current
    let cancelled = false
    void onLoadDshSettings()
      .catch(() => undefined)
      .then((snapshot) => {
        if (!cancelled && openEpochRef.current === epoch) {
          if (snapshot !== undefined) {
            const hostLocale = settingValueAt(snapshot.values, 'locale.preference')
            if (isLocale(hostLocale)) onLocaleFromDsh(hostLocale)
            const preferences = readDshUiPreferences(snapshot)
            if (preferences.theme !== undefined) onThemeChange(preferences.theme)
          }
          if (snapshot !== undefined) {
            setDshState({ status: 'ready', snapshot })
            setDshSettingsSnapshotFresh(true)
          } else if (!hadSnapshot) {
            setDshState({ status: 'unavailable' })
            setDshSettingsSnapshotFresh(false)
          } else setDshSettingsSnapshotFresh(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, onLoadDshSettings, onLocaleFromDsh, onThemeChange, dshState.status])

  useEffect(() => {
    if (!open) {
      dshUpdateCheckStarted.current = false
      return
    }
    if (dshUpdateCheckStarted.current || dshUpdate !== undefined || onCheckDshUpdates === undefined) return
    dshUpdateCheckStarted.current = true
    void onCheckDshUpdates(false).catch(() => undefined)
  }, [open, dshUpdate, onCheckDshUpdates])

  const saveSetting = useStableCallback((path: string, value: unknown): void => {
    if (savingPath !== undefined) return
    if (
      dshState.status !== 'ready' ||
      !dshSettingsSnapshotFresh ||
      !isValidGeneralSettingChange(dshState.snapshot, path, value)
    )
      return
    const expectedRevision = settingsNamespaceRevision(dshState.snapshot, namespaceInPath(path))
    if (expectedRevision === undefined) {
      setSaveError(t('settings.updateFailed'))
      return
    }
    const themeValue = path === 'ui-theme.preference' && isThemePreference(value) ? value : undefined
    const previousTheme = props.theme
    setSaveError(undefined)
    setRiskPending(undefined)
    setRiskAcknowledged(false)
    setSavingPath(path)
    if (themeValue !== undefined) props.onThemeChange(themeValue)
    const epoch = openEpochRef.current
    void (async () => {
      let accepted = false
      try {
        await onUpdateDshSetting(path, value, expectedRevision)
        accepted = true
      } catch (reason: unknown) {
        if (openEpochRef.current !== epoch) return
        if (themeValue !== undefined) props.onThemeChange(previousTheme)
        setSaveError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
      }
      if (openEpochRef.current !== epoch) return

      // A conflict or transport failure must reload authoritative state. A
      // successful write is already committed, so keep its selected value
      // visible if this read fails, while disabling every CAS write until a
      // fresh namespace revision is available.
      const snapshot = await onLoadDshSettings().catch(() => undefined)
      if (openEpochRef.current !== epoch) return
      if (snapshot !== undefined) {
        setDshState({ status: 'ready', snapshot })
        setDshSettingsSnapshotFresh(true)
        const preferences = readDshUiPreferences(snapshot)
        if (themeValue !== undefined && preferences.theme !== undefined) onThemeChange(preferences.theme)
      } else if (accepted) {
        setDshState((current) =>
          current.status === 'ready'
            ? { status: 'ready', snapshot: withSettingValue(current.snapshot, path, value) }
            : current,
        )
        setDshSettingsSnapshotFresh(false)
      } else {
        setDshState({ status: 'unavailable' })
        setDshSettingsSnapshotFresh(false)
      }
    })().finally(() => setSavingPath(undefined))
  })

  const updateDisplayedSetting = useStableCallback(async (path: string, value: unknown): Promise<void> => {
    if (dshState.status !== 'ready' || !dshSettingsSnapshotFresh) throw new Error(t('settings.updateFailed'))
    const expectedRevision = settingsNamespaceRevision(dshState.snapshot, namespaceInPath(path))
    if (expectedRevision === undefined) throw new Error(t('settings.updateFailed'))
    const epoch = openEpochRef.current
    try {
      await props.onUpdateDshSetting(path, value, expectedRevision)
    } catch (reason: unknown) {
      const snapshot = await onLoadDshSettings().catch(() => undefined)
      if (openEpochRef.current === epoch) {
        if (snapshot === undefined) {
          setDshState({ status: 'unavailable' })
          setDshSettingsSnapshotFresh(false)
        } else {
          setDshState({ status: 'ready', snapshot })
          setDshSettingsSnapshotFresh(true)
        }
      }
      throw reason
    }
    const snapshot = await onLoadDshSettings().catch(() => undefined)
    if (openEpochRef.current !== epoch) return
    if (snapshot === undefined) {
      setDshState({ status: 'unavailable' })
      setDshSettingsSnapshotFresh(false)
      return
    }
    setDshState({ status: 'ready', snapshot })
    setDshSettingsSnapshotFresh(true)
  })

  const applyConnection = useStableCallback((): void => {
    if (connectionBusy || connectionChoice === 'unchanged') return
    const endpoint = connectionEndpoint.trim()
    if (connectionChoice === 'custom' && endpoint === '') {
      setConnectionError(t('settings.connectionEndpointRequired'))
      setConnectionNotice(undefined)
      return
    }
    setConnectionBusy(true)
    setConnectionError(undefined)
    setConnectionNotice(undefined)
    const epoch = openEpochRef.current
    void props
      .onConfigureConnection(connectionChoice, connectionChoice === 'custom' ? endpoint : undefined)
      .then(async () => {
        const value = await onLoadSettings().catch(() => undefined)
        if (openEpochRef.current !== epoch) return
        if (value !== undefined) setSettingsState({ value })
        setConnectionEndpoint('')
        setConnectionNotice(t('settings.connectionApplied'))
      })
      .catch((reason: unknown) => {
        if (openEpochRef.current !== epoch) return
        setConnectionError(reason instanceof Error ? reason.message : t('settings.connectionApplyFailed'))
      })
      .finally(() => setConnectionBusy(false))
  })

  // The drawer is the modal focus trap: Tab stays inside it and everything
  // behind it goes inert. Layers opened inside the drawer (provider dropdowns,
  // the remove-provider confirmation) stack on top, so Escape and Tab reach
  // the innermost surface first and the drawer closes only when it is on top.
  useDismissibleLayer({
    open,
    refs: [sectionRef],
    onDismiss: () => onOpenChange(false),
    onEscape: () => onOpenChange(false),
    trapFocus: true,
  })
  useDismissibleLayer({
    open: removeProviderOpen,
    refs: [removeDialogRef],
    onDismiss: () => setRemovingProviderId(undefined),
    onEscape: () => setRemovingProviderId(undefined),
    trapFocus: true,
  })

  const availableDshVersions = dshUpdate?.availableVersions ?? []
  const effectiveSelectedDshVersion =
    selectedDshVersion !== undefined && availableDshVersions.includes(selectedDshVersion)
      ? selectedDshVersion
      : (dshUpdate?.latestVersion ?? availableDshVersions[0])
  const selectedDshVersionAlreadyInstalled =
    dshUpdate?.status === 'ready' &&
    effectiveSelectedDshVersion !== undefined &&
    dshUpdate.globalVersion === effectiveSelectedDshVersion

  const modelsByProvider = new Map<string, ModelDescriptor[]>()
  for (const model of props.models) {
    const group = modelsByProvider.get(model.providerId)
    if (group === undefined) {
      modelsByProvider.set(model.providerId, [model])
    } else {
      group.push(model)
    }
  }

  // Provider writes share the epoch guard and the CAS revision dance; the
  // flows live together in one hook so the drawer keeps only the view state.
  const {
    runSecretAction,
    saveProviderChanges,
    saveCustomProvider,
    configureCustomProviderSecret,
    removeProvider,
  } = useProviderSettingsFlows({
    t,
    openEpochRef,
    dshState,
    dshSettingsSnapshotFresh,
    busyField,
    onLoadDshSettings,
    onRefreshCatalog: props.onRefreshCatalog,
    onMutateDshSettings: props.onMutateDshSettings,
    onCreateCustomProvider: props.onCreateCustomProvider,
    onConfigureSecret: props.onConfigureSecret,
    onUnsetDshSetting: props.onUnsetDshSetting,
    onRemoveSecret: props.onRemoveSecret,
    setSaveError,
    setBusyField,
    setDshState,
    setDshSettingsSnapshotFresh,
    setEditingProviderId,
    setAddingProviderId,
    setAddingCustomProvider,
    setRemovingProviderId,
  })
  const openSettingsDocument = (): void => {
    if (busyField !== undefined) return
    setDocumentError(undefined)
    setBusyField('settings-document')
    void props
      .onOpenDshSettingsDocument()
      .catch((reason: unknown) =>
        setDocumentError(reason instanceof Error ? reason.message : t('settings.openDocumentFailed')),
      )
      .finally(() => setBusyField(undefined))
  }

  const openKeyboardShortcuts = (): void => {
    if (busyField !== undefined) return
    setKeyboardShortcutsError(undefined)
    setBusyField('keyboard-shortcuts')
    void props
      .onOpenKeyboardShortcuts()
      .catch((reason: unknown) =>
        setKeyboardShortcutsError(
          reason instanceof Error ? reason.message : t('settings.keyboardShortcutsFailed'),
        ),
      )
      .finally(() => setBusyField(undefined))
  }

  const checkDshUpdates = (): void => {
    if (dshUpdateBusy !== undefined || onCheckDshUpdates === undefined) return
    setDshUpdateError(undefined)
    setDshUpdateBusy('check')
    void onCheckDshUpdates(true)
      .catch((reason: unknown) =>
        setDshUpdateError(reason instanceof Error ? reason.message : t('settings.dshUpdateFailed')),
      )
      .finally(() => setDshUpdateBusy(undefined))
  }

  const installDshVersion = (): void => {
    if (
      dshUpdateBusy !== undefined ||
      effectiveSelectedDshVersion === undefined ||
      selectedDshVersionAlreadyInstalled ||
      onInstallDshVersion === undefined
    )
      return
    setDshUpdateError(undefined)
    setDshUpdateBusy('install')
    void onInstallDshVersion(effectiveSelectedDshVersion)
      .then((snapshot) => {
        if (snapshot === undefined) {
          setDshUpdateError(t('settings.dshUpdateFailed'))
          return
        }
        if (snapshot.status === 'unavailable') setDshUpdateError(dshUpdateFailureMessage(snapshot.failure, t))
        return snapshot
      })
      .catch((reason: unknown) =>
        setDshUpdateError(reason instanceof Error ? reason.message : t('settings.dshUpdateFailed')),
      )
      .finally(() => setDshUpdateBusy(undefined))
  }

  if (!open) return <></>

  const customProviderTemplate: CustomProviderTemplate | undefined =
    dshState.status === 'ready' ? deriveCustomProviderTemplate(props.providers, dshState.snapshot) : undefined
  const addableProviders =
    dshState.status === 'ready'
      ? props.providers.filter((provider) => isAddableProvider(provider, dshState.snapshot))
      : []
  const addingProvider =
    addingProviderId === undefined
      ? undefined
      : addableProviders.find((provider) => provider.id === addingProviderId)
  const canAddCustomProvider = customProviderTemplate !== undefined
  const providerRows =
    dshState.status === 'ready'
      ? props.providers.filter((provider) => isConfiguredProvider(provider, dshState.snapshot))
      : dshState.status === 'unavailable'
        ? props.providers
        : []
  const orderedProviderRows = providerRows
    .filter(
      (provider) =>
        provider.id !== 'deepseek-account' || (modelsByProvider.get(provider.id)?.length ?? 0) > 0,
    )
    .sort((left, right) => providerRowOrder(left) - providerRowOrder(right))
  const pendingProvider =
    removingProviderId === undefined
      ? undefined
      : props.providers.find((provider) => provider.id === removingProviderId)
  const generalView = {
    props,
    t,
    settingsState,
    refreshAccountDetails,
    acknowledgeAccountBonus,
    openAccountUsage,
    openAccountTopUp,
    connectionChoice,
    setConnectionChoice,
    connectionEndpoint,
    setConnectionEndpoint,
    connectionBusy,
    connectionError,
    setConnectionError,
    connectionNotice,
    setConnectionNotice,
    applyConnection,
    dshUpdateBusy,
    checkDshUpdates,
    installDshVersion,
    dshUpdateError,
    availableDshVersions,
    effectiveSelectedDshVersion,
    selectedDshVersionAlreadyInstalled,
    setSelectedDshVersion,
    dshState,
    dshUiPreferences,
    dshSettingsSnapshotFresh,
    retryDshSettings,
    savingPath,
    riskPending,
    setRiskPending,
    riskAcknowledged,
    setRiskAcknowledged,
    saveSetting,
    saveError,
    busyField,
    openSettingsDocument,
    documentError,
    openKeyboardShortcuts,
    keyboardShortcutsError,
  }
  const modelsView = {
    props,
    t,
    orderedProviderRows,
    modelsByProvider,
    busyField,
    setBusyField,
    saveError,
    setSaveError,
    dshState,
    dshSettingsSnapshotFresh,
    editingProviderId,
    setEditingProviderId,
    setAddingProviderId,
    setAddingCustomProvider,
    setRemovingProviderId,
    removeProviderTriggerRef,
    removeDialogRef,
    runSecretAction,
    saveProviderChanges,
    addableProviders,
    canAddCustomProvider,
    addingProvider,
    addingCustomProvider,
    customProviderTemplate,
    saveCustomProvider,
    configureCustomProviderSecret,
    pendingProvider,
    removeProvider,
  }

  return (
    <ModalWrapper
      className="dsh-settings__backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onOpenChange(false)
      }}
    >
      <section
        ref={sectionRef}
        className="dsh-settings"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
      >
        <header className="dsh-settings__header">
          <h2 id="settings-title">{t('settings.title')}</h2>
          <button
            ref={closeRef}
            className="dsh-icon-button"
            type="button"
            aria-label={t('settings.close')}
            title={t('settings.close')}
            onClick={() => props.onOpenChange(false)}
          >
            <Icon name="close" />
          </button>
        </header>
        <SettingsTabs
          panels={{
            general: <GeneralSettingsTab {...generalView} />,
            models: <ModelsSettingsTab {...modelsView} />,
            presets: (
              <PresetsSettingsTab
                props={props}
                t={t}
                dshState={dshState}
                dshSettingsSnapshotFresh={dshSettingsSnapshotFresh}
                codingToolsEnabled={dshUiPreferences?.codingToolsEnabled === true}
                updateDisplayedSetting={updateDisplayedSetting}
              />
            ),
            plugins: (
              <PluginsSettingsTab
                props={props}
                t={t}
                dshState={dshState}
                dshSettingsSnapshotFresh={dshSettingsSnapshotFresh}
                openEpochRef={openEpochRef}
                setDshState={setDshState}
                setDshSettingsSnapshotFresh={setDshSettingsSnapshotFresh}
              />
            ),
          }}
        />
      </section>
    </ModalWrapper>
  )
}
