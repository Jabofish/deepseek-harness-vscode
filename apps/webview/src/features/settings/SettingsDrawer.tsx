import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type {
  AgentPresetDocument,
  AgentPresetLocation,
  AgentPresetRoster,
  CustomProviderCreateResult,
  CustomProviderDraft,
  DshSettingsSchema,
  DshRuntimeUpdateProgress,
  DshUpdateSnapshot,
  DiscoveredModel,
  ExtensionSettingsSummary,
  ModelDescriptor,
  ModelDiscoveryInput,
  ModelProvider,
  PluginInstallProgressView,
  PluginInventorySnapshot,
  SettingsPathOperation,
} from '@dsh-vscode/domain'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import type {
  AccountLifecycleErrorCodeDto,
  AccountProfileDetailsSnapshotDto,
  AccountLifecycleSnapshotDto,
  AccountSignOutImpactDto,
} from '@dsh-vscode/webview-protocol'
import type { DshSettingsSnapshot } from '../../app/store.js'
import type { PluginInstallInput, PluginInstallRecoveryState } from '../../app/plugin-install-recovery.js'
import {
  CONVERSATION_FONT_SIZE_OPTIONS,
  DEFAULT_CONVERSATION_FONT_SIZE_PX,
  DSH_UI_SETTING_PATHS,
  MAX_CONVERSATION_FONT_SIZE_PX,
  MIN_CONVERSATION_FONT_SIZE_PX,
  dshUiPreferences as readDshUiPreferences,
  findDshSettingsField,
  isConversationFontSizePx,
  isPerformanceUsageMode,
  isTranscriptViewMode,
  isThemePreference,
  type ConversationFontSize,
  type ThemePreference,
} from '../../app/ui-preferences.js'
import { ModalWrapper } from '../../components/common/PopoverCard.js'
import { SettingCard, SettingRow } from '../../components/common/SettingCard.js'
import { SelectMenu } from '../../components/common/SelectMenu.js'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
import { Icon } from '../../ui/Icon.js'
import { PluginInventory } from '../plugins/PluginInventory.js'
import { OptionalBundleManager } from '../plugins/OptionalBundleManager.js'
import { PluginConfiguration } from '../plugins/PluginConfiguration.js'
import {
  AccountLifecycle,
  type AccountLifecycleLabels,
  type AccountLifecycleUiError,
  type AccountLifecycleUiPhase,
} from '../account/AccountLifecycle.js'
import { AccountProfile, type AccountProfileLabels } from '../account/AccountProfile.js'
import { PresetManager } from './PresetManager.js'
import { CustomProviderCard, type CustomProviderTemplate } from './CustomProviderCard.js'
import { ProviderSettingsEditor, type ProviderSettingChange } from './ProviderSettingsEditor.js'
import { useI18n, type Locale, type Translate } from '../../i18n.js'

export interface SettingsDrawerProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly connected: boolean
  readonly connectedDshVersion: string | undefined
  readonly onConfigureConnection: (mode: 'auto' | 'custom', endpoint?: string) => Promise<void>
  readonly dshUpdate?: DshUpdateSnapshot | undefined
  readonly dshUpdateProgress?: DshRuntimeUpdateProgress | undefined
  readonly onCheckDshUpdates?: (force?: boolean) => Promise<DshUpdateSnapshot | undefined>
  readonly onInstallDshVersion?: (version: string) => Promise<DshUpdateSnapshot | undefined>
  readonly theme: ThemePreference
  readonly onThemeChange: (value: ThemePreference) => void
  readonly locale: Locale
  /** Apply the shared extension/DSH language preference from a user action. */
  readonly onLocaleChange: (value: Locale) => void
  /** Adopt the authoritative DSH locale without issuing a second write. */
  readonly onLocaleFromDsh: (value: Locale) => void
  readonly conversationFontSize: ConversationFontSize
  readonly onConversationFontSizeChange: (value: ConversationFontSize) => void
  readonly providers: readonly ModelProvider[]
  readonly models: readonly ModelDescriptor[]
  readonly onLoadSettings: () => Promise<ExtensionSettingsSummary | undefined>
  readonly onLoadDshSettings: () => Promise<DshSettingsSnapshot | undefined>
  readonly onOpenDshSettingsDocument: () => Promise<void>
  readonly onOpenKeyboardShortcuts: () => Promise<void>
  readonly onUpdateDshSetting: (path: string, value: unknown, expectedRevision: number) => Promise<void>
  readonly onUnsetDshSetting: (path: string, expectedRevision: number) => Promise<void>
  readonly onMutateDshSettings: (
    namespace: string,
    operations: readonly SettingsPathOperation[],
    expectedRevision: number,
  ) => Promise<void>
  readonly onCreateCustomProvider: (draft: CustomProviderDraft) => Promise<CustomProviderCreateResult>
  readonly onDiscoverModels: (
    input: Omit<ModelDiscoveryInput, 'apiKey'>,
  ) => Promise<readonly DiscoveredModel[]>
  readonly onDiscoverCustomModels: (
    input: Omit<ModelDiscoveryInput, 'apiKey'>,
  ) => Promise<readonly DiscoveredModel[]>
  readonly onConfigureSecret: (providerId: string, field: string) => Promise<boolean>
  readonly onRemoveSecret: (providerId: string, field: string) => Promise<void>
  /** Host-mediated plugin credential actions; the secret never enters the Webview. */
  readonly onConfigurePluginCredential?: (ref: string) => Promise<boolean>
  readonly onRemovePluginCredential?: (ref: string) => Promise<void>
  readonly onRefreshCatalog: () => Promise<void>
  readonly onLoadPresetRoster: () => Promise<AgentPresetRoster | undefined>
  readonly onReadPresetDocument: (presetId: string) => Promise<AgentPresetDocument | undefined>
  readonly onCopyPreset: (from: string, presetId: string, name?: string) => Promise<string | undefined>
  readonly onRemovePreset: (presetId: string) => Promise<void>
  readonly onOpenPresetDocument: (presetId: string) => Promise<AgentPresetLocation | undefined>
  readonly onStartCreatorDraft?: () => Promise<void>
  readonly pluginInventoryRevision?: number
  readonly pluginInstallProgress?: PluginInstallProgressView | undefined
  readonly pluginInstallOperation?: PluginInstallRecoveryState | undefined
  readonly onStartPluginInstall?: (input: PluginInstallInput) => Promise<void>
  readonly onCancelPluginInstall?: () => Promise<void>
  readonly onRecoverPluginInstall?: () => Promise<void>
  readonly onLoadPluginInventory: () => Promise<PluginInventorySnapshot | undefined>
  readonly featureRequest?: <T>(request: FeatureRequest) => Promise<T>
  readonly accountLifecycleAvailable?: boolean
  readonly accountLifecycle?: AccountLifecycleSnapshotDto | null
  readonly accountLifecycleLoading?: boolean
  readonly accountLifecycleBusy?: boolean
  readonly accountLifecycleImpact?: AccountSignOutImpactDto
  readonly accountSessionExpired?: boolean
  readonly accountLifecycleError?: AccountLifecycleErrorCodeDto
  readonly accountLifecycleRequestFailed?: boolean
  readonly accountProfileDetails?: AccountProfileDetailsSnapshotDto | null
  readonly accountProfileLoading?: boolean
  readonly accountProfileRequestFailed?: boolean
  readonly onLoadAccountLifecycle?: () => Promise<void>
  readonly onLoadAccountDetails?: () => Promise<void>
  readonly onAcknowledgeAccountBonus?: (orderId: string) => Promise<boolean>
  readonly onOpenAccountPage?: (page: 'usage' | 'top-up') => void
  readonly onStartAccountSignIn?: () => Promise<void>
  readonly onCancelAccountSignIn?: (attemptId: string) => Promise<void>
  readonly onCheckAccountSignOutImpact?: () => Promise<void>
  readonly onSignOutAccount?: () => Promise<void>
}

type SettingsTab = 'general' | 'models' | 'presets' | 'plugins'
type SettingsTabOrientation = 'horizontal' | 'vertical'
/**
 * 'unchanged' is not a mode: it marks attach-only/new-isolated settings this
 * page cannot represent. Nothing is pre-selected and Apply stays disabled, so
 * applying can never silently rewrite those modes to 'auto'.
 */
type ConnectionChoice = 'auto' | 'custom' | 'unchanged'

const SETTINGS_TABS: readonly SettingsTab[] = ['general', 'models', 'presets', 'plugins']
const LOCALE_OPTIONS: readonly Locale[] = ['en', 'zh']

function settingsTabOrientation(): SettingsTabOrientation {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 52rem)').matches
    ? 'horizontal'
    : 'vertical'
}

interface LoadedSettings {
  readonly value: ExtensionSettingsSummary | undefined
}

type DshSettingsState =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'ready'; readonly snapshot: DshSettingsSnapshot }

/** A full-access confirmation waiting for the user, keyed by row path. */
interface RiskPending {
  readonly path: string
  readonly value: string
}

/** Official General-section rows in upstream feature-slot order. A row renders
 * only when the DSH host schema advertises its field — the client never
 * fabricates a control for a namespace the host did not expose. */
const GENERAL_SETTING_ROWS: readonly {
  readonly path: string
  readonly labelKey: string
  readonly hintKey: string
  readonly defaultValue?: string
}[] = [
  {
    path: 'permission.defaultPreset',
    labelKey: 'settings.permission.label',
    hintKey: 'settings.permission.hint',
  },
  {
    path: 'ui-theme.preference',
    labelKey: 'settings.appearance.label',
    hintKey: 'settings.appearance.hint',
  },
  {
    path: 'ui-chat.transcriptView',
    labelKey: 'settings.transcriptView.label',
    hintKey: 'settings.transcriptView.hint',
    defaultValue: 'standard',
  },
  {
    path: 'ui-chat.performanceUsage',
    labelKey: 'settings.performanceUsage.label',
    hintKey: 'settings.performanceUsage.hint',
    defaultValue: 'detailed',
  },
  {
    path: 'ui-conversation.busyEnter',
    labelKey: 'settings.enter.label',
    hintKey: 'settings.enter.hint',
    defaultValue: 'queue',
  },
]

/** Upstream RiskConfirmation tier: values that grant unrestricted tools. */
function isRiskValue(value: string): boolean {
  return value === 'danger-full-access'
}

export function SettingsDrawer(props: SettingsDrawerProps): ReactElement {
  const { t } = useI18n()
  const { onLoadAccountDetails, onAcknowledgeAccountBonus, onOpenAccountPage } = props
  const [tabOrientation, setTabOrientation] = useState<SettingsTabOrientation>(settingsTabOrientation)
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
    dshUpdateProgress,
    onCheckDshUpdates,
    onInstallDshVersion,
    onLoadSettings,
    onLoadDshSettings,
    onLocaleFromDsh,
    onThemeChange,
    onUpdateDshSetting,
    onOpenChange,
  } = props
  const [tab, setTab] = useState<SettingsTab>('general')
  const [settingsState, setSettingsState] = useState<LoadedSettings | undefined>(undefined)
  const [dshState, setDshState] = useState<DshSettingsState>({ status: 'loading' })
  const [dshSettingsSnapshotFresh, setDshSettingsSnapshotFresh] = useState(false)
  const dshSettingsOpenedRef = useRef(false)
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

  const retryDshSettings = (): void => {
    void onLoadDshSettings()
      .then((snapshot) => {
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
        if (dshState.status !== 'ready') setDshState({ status: 'unavailable' })
        setDshSettingsSnapshotFresh(false)
      })
  }

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(max-width: 52rem)')
    const updateOrientation = (event: MediaQueryListEvent): void => {
      setTabOrientation(event.matches ? 'horizontal' : 'vertical')
    }
    query.addEventListener('change', updateOrientation)
    return () => query.removeEventListener('change', updateOrientation)
  }, [])

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
    let cancelled = false
    void onLoadSettings()
      .catch(() => undefined)
      .then((value) => {
        if (cancelled) return
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
    if (!open) setSettingsState(undefined)
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
    let cancelled = false
    void onLoadDshSettings()
      .catch(() => undefined)
      .then((snapshot) => {
        if (!cancelled) {
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

  const saveSetting = (path: string, value: unknown): void => {
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
    void (async () => {
      let accepted = false
      try {
        await onUpdateDshSetting(path, value, expectedRevision)
        accepted = true
      } catch (reason: unknown) {
        if (themeValue !== undefined) props.onThemeChange(previousTheme)
        setSaveError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
      }

      // A conflict or transport failure must reload authoritative state. A
      // successful write is already committed, so keep its selected value
      // visible if this read fails, while disabling every CAS write until a
      // fresh namespace revision is available.
      const snapshot = await onLoadDshSettings().catch(() => undefined)
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
  }

  const updateDisplayedSetting = async (path: string, value: unknown): Promise<void> => {
    if (dshState.status !== 'ready' || !dshSettingsSnapshotFresh) throw new Error(t('settings.updateFailed'))
    const expectedRevision = settingsNamespaceRevision(dshState.snapshot, namespaceInPath(path))
    if (expectedRevision === undefined) throw new Error(t('settings.updateFailed'))
    try {
      await props.onUpdateDshSetting(path, value, expectedRevision)
    } catch (reason: unknown) {
      const snapshot = await onLoadDshSettings().catch(() => undefined)
      if (snapshot === undefined) {
        setDshState({ status: 'unavailable' })
        setDshSettingsSnapshotFresh(false)
      } else {
        setDshState({ status: 'ready', snapshot })
        setDshSettingsSnapshotFresh(true)
      }
      throw reason
    }
    const snapshot = await onLoadDshSettings().catch(() => undefined)
    if (snapshot === undefined) {
      setDshState({ status: 'unavailable' })
      setDshSettingsSnapshotFresh(false)
      return
    }
    setDshState({ status: 'ready', snapshot })
    setDshSettingsSnapshotFresh(true)
  }

  const applyConnection = (): void => {
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
    void props
      .onConfigureConnection(connectionChoice, connectionChoice === 'custom' ? endpoint : undefined)
      .then(async () => {
        const value = await onLoadSettings().catch(() => undefined)
        if (value !== undefined) setSettingsState({ value })
        setConnectionEndpoint('')
        setConnectionNotice(t('settings.connectionApplied'))
      })
      .catch((reason: unknown) => {
        setConnectionError(reason instanceof Error ? reason.message : t('settings.connectionApplyFailed'))
      })
      .finally(() => setConnectionBusy(false))
  }

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

  if (!open) return <></>

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

  const runSecretAction = (key: string, action: () => Promise<void>): void => {
    if (busyField !== undefined) return
    setSaveError(undefined)
    setBusyField(key)
    void action()
      .then(() => props.onRefreshCatalog())
      .catch((reason: unknown) =>
        setSaveError(reason instanceof Error ? reason.message : t('settings.updateFailed')),
      )
      .finally(() => setBusyField(undefined))
  }

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

  const saveProviderChanges = async (
    provider: ModelProvider,
    changes: readonly ProviderSettingChange[],
    expectedRevision: number,
    ensureProvider = false,
  ): Promise<void> => {
    if (busyField !== undefined || !dshSettingsSnapshotFresh) throw new Error(t('settings.updateFailed'))
    const namespace = provider.settingsNs?.trim()
    if (namespace === undefined || namespace === '') throw new Error(t('settings.updateFailed'))
    const operations =
      changes.length === 0 && ensureProvider
        ? (() => {
            const relativePath = provider.settingsPath ?? []
            return relativePath.length === 0 || relativePath.some((part) => part.trim() === '')
              ? undefined
              : [{ op: 'set' as const, path: relativePath, value: {} }]
          })()
        : providerSettingOperations(provider, changes)
    if (operations === undefined || (operations.length === 0 && ensureProvider))
      throw new Error(t('settings.updateFailed'))
    if (operations.length === 0) return
    setSaveError(undefined)
    setBusyField(`provider:${provider.id}`)
    try {
      try {
        await props.onMutateDshSettings(namespace, operations, expectedRevision)
      } catch (reason: unknown) {
        const snapshot = await onLoadDshSettings().catch(() => undefined)
        setDshState(snapshot === undefined ? { status: 'unavailable' } : { status: 'ready', snapshot })
        setDshSettingsSnapshotFresh(snapshot !== undefined)
        const latestRevision =
          snapshot === undefined ? undefined : settingsNamespaceRevision(snapshot, namespace)
        if (
          isSettingsConflict(reason) ||
          snapshot === undefined ||
          latestRevision !== expectedRevision ||
          !isKnownRejectedSettingsWrite(reason)
        ) {
          setEditingProviderId(undefined)
          if (ensureProvider) setAddingProviderId(undefined)
        }
        setSaveError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
        throw reason
      }
      const snapshot = await onLoadDshSettings().catch(() => undefined)
      if (snapshot === undefined) {
        setDshState({ status: 'unavailable' })
        setDshSettingsSnapshotFresh(false)
        setEditingProviderId(undefined)
        if (ensureProvider) setAddingProviderId(undefined)
        return
      }
      setDshState({ status: 'ready', snapshot })
      setDshSettingsSnapshotFresh(true)
      try {
        await props.onRefreshCatalog()
      } catch (reason: unknown) {
        // The profile mutation has committed. Keep the editor closed so a
        // catalog refresh failure cannot invite a duplicate write at its old
        // revision.
        setEditingProviderId(undefined)
        if (ensureProvider) setAddingProviderId(undefined)
        setSaveError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
      }
    } finally {
      setBusyField(undefined)
    }
  }

  const saveCustomProvider = async (draft: CustomProviderDraft): Promise<CustomProviderCreateResult> => {
    if (busyField !== undefined || !dshSettingsSnapshotFresh) throw new Error(t('settings.updateFailed'))
    setSaveError(undefined)
    const path = [draft.settingsNamespace, ...draft.collectionPath, draft.providerId].join('.')
    setBusyField(`provider:${path}`)
    try {
      const result = await props.onCreateCustomProvider(draft)
      // The Host operation is CAS-protected and may already have committed the
      // profile when a follow-up refresh fails. Keep the committed result so
      // the card can enter its credential-only retry state instead of asking
      // the user to repeat a profile write with a stale revision.
      try {
        const snapshot = await onLoadDshSettings()
        if (snapshot !== undefined) {
          setDshState({ status: 'ready', snapshot })
          setDshSettingsSnapshotFresh(true)
        } else {
          setDshState({ status: 'unavailable' })
          setDshSettingsSnapshotFresh(false)
          setAddingCustomProvider(false)
          return result
        }
        await props.onRefreshCatalog()
      } catch (reason: unknown) {
        setSaveError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
      }
      return result
    } catch (reason: unknown) {
      setSaveError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
      throw reason
    } finally {
      setBusyField(undefined)
    }
  }

  const configureCustomProviderSecret = async (providerId: string, field: string): Promise<boolean> => {
    if (busyField !== undefined) throw new Error(t('settings.updateFailed'))
    setSaveError(undefined)
    setBusyField(`provider:${providerId}:credential`)
    try {
      const configured = await props.onConfigureSecret(providerId, field)
      if (configured) {
        const snapshot = await onLoadDshSettings()
        if (snapshot !== undefined) {
          setDshState({ status: 'ready', snapshot })
          setDshSettingsSnapshotFresh(true)
        } else {
          setDshState({ status: 'unavailable' })
          setDshSettingsSnapshotFresh(false)
        }
        await props.onRefreshCatalog()
      }
      return configured
    } catch (reason: unknown) {
      setSaveError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
      throw reason
    } finally {
      setBusyField(undefined)
    }
  }

  const removeProvider = async (provider: ModelProvider): Promise<void> => {
    if (
      busyField !== undefined ||
      !dshSettingsSnapshotFresh ||
      provider.settingsNs === undefined ||
      provider.settingsPath === undefined
    )
      return
    setSaveError(undefined)
    setBusyField(`remove-provider:${provider.id}`)
    try {
      const expectedRevision =
        dshState.status === 'ready' && dshSettingsSnapshotFresh && provider.settingsNs !== undefined
          ? settingsNamespaceRevision(dshState.snapshot, provider.settingsNs)
          : undefined
      if (expectedRevision === undefined) throw new Error(t('settings.updateFailed'))
      // Commit the CAS protected profile removal before cleaning its secrets.
      // A conflict must not delete credentials while leaving the profile in
      // place. Credential cleanup remains Host-owned and never exposes a key.
      await props.onUnsetDshSetting(
        [provider.settingsNs, ...provider.settingsPath].join('.'),
        expectedRevision,
      )
      setRemovingProviderId(undefined)
      setEditingProviderId(undefined)
      for (const field of provider.fields) {
        if (!field.secret || field.value === undefined || field.writable === false) continue
        await props.onRemoveSecret(provider.id, field.key)
      }
      const snapshot = await onLoadDshSettings()
      if (snapshot === undefined) {
        setDshState({ status: 'unavailable' })
        setDshSettingsSnapshotFresh(false)
        return
      }
      setDshState({ status: 'ready', snapshot })
      setDshSettingsSnapshotFresh(true)
      try {
        await props.onRefreshCatalog()
      } catch (reason: unknown) {
        setSaveError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
      }
    } catch (reason: unknown) {
      const snapshot = await onLoadDshSettings().catch(() => undefined)
      setDshState(snapshot === undefined ? { status: 'unavailable' } : { status: 'ready', snapshot })
      setDshSettingsSnapshotFresh(snapshot !== undefined)
      if (isSettingsConflict(reason)) setRemovingProviderId(undefined)
      setSaveError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
    } finally {
      setBusyField(undefined)
    }
  }

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
        <div className="dsh-settings__layout">
          <nav
            className="dsh-settings__tabs"
            role="tablist"
            aria-label={t('settings.sections')}
            aria-orientation={tabOrientation}
          >
            {SETTINGS_TABS.map((entry) => (
              <button
                key={entry}
                id={`dsh-settings-tab-${entry}`}
                className={`dsh-settings__tab${tab === entry ? ' dsh-settings__tab--active' : ''}`}
                type="button"
                role="tab"
                aria-selected={tab === entry}
                aria-controls={tab === entry ? `dsh-settings-panel-${entry}` : undefined}
                tabIndex={tab === entry ? 0 : -1}
                onClick={() => setTab(entry)}
                onKeyDown={(event) => {
                  const index = SETTINGS_TABS.indexOf(entry)
                  let next: SettingsTab | undefined
                  if (event.key === 'Home') next = SETTINGS_TABS[0]
                  else if (event.key === 'End') next = SETTINGS_TABS[SETTINGS_TABS.length - 1]
                  else if (
                    (tabOrientation === 'horizontal' && event.key === 'ArrowRight') ||
                    (tabOrientation === 'vertical' && event.key === 'ArrowDown')
                  )
                    next = SETTINGS_TABS[(index + 1) % SETTINGS_TABS.length]
                  else if (
                    (tabOrientation === 'horizontal' && event.key === 'ArrowLeft') ||
                    (tabOrientation === 'vertical' && event.key === 'ArrowUp')
                  )
                    next = SETTINGS_TABS[(index + SETTINGS_TABS.length - 1) % SETTINGS_TABS.length]
                  else return

                  event.preventDefault()
                  if (next === undefined) return
                  setTab(next)
                  document.getElementById(`dsh-settings-tab-${next}`)?.focus()
                }}
              >
                {t(`settings.${entry}`)}
              </button>
            ))}
          </nav>
          <div className="dsh-settings__content">
            {tab === 'general' ? (
              <div
                className="dsh-settings__body"
                id="dsh-settings-panel-general"
                role="tabpanel"
                aria-labelledby="dsh-settings-tab-general"
                aria-label={t('settings.generalAria')}
              >
                {props.accountLifecycleAvailable === true ? (
                  <>
                    <AccountLifecycle
                      snapshot={
                        props.accountLifecycleLoading === true ? null : (props.accountLifecycle ?? null)
                      }
                      {...(props.accountLifecycleImpact === undefined
                        ? {}
                        : { impact: props.accountLifecycleImpact })}
                      sessionExpired={props.accountSessionExpired === true}
                      {...(props.accountLifecycleError === undefined
                        ? {}
                        : { hostError: props.accountLifecycleError })}
                      requestFailed={props.accountLifecycleRequestFailed === true}
                      busy={props.accountLifecycleBusy === true || props.accountLifecycleLoading === true}
                      labels={accountLifecycleLabels(t)}
                      onSignIn={() => void props.onStartAccountSignIn?.()}
                      onCancelSignIn={(attemptId) => void props.onCancelAccountSignIn?.(attemptId)}
                      onCheckSignOutImpact={() => void props.onCheckAccountSignOutImpact?.()}
                      onSignOut={() => void props.onSignOutAccount?.()}
                      onRetry={() => void props.onLoadAccountLifecycle?.()}
                    />
                    <AccountProfile
                      snapshot={props.accountProfileDetails ?? null}
                      signedIn={props.accountLifecycle?.status === 'credential-stored'}
                      busy={props.accountProfileLoading === true}
                      requestFailed={props.accountProfileRequestFailed === true}
                      labels={accountProfileLabels(t)}
                      locale={props.locale}
                      onRefresh={refreshAccountDetails}
                      onAcknowledgeBonus={acknowledgeAccountBonus}
                      onOpenUsage={openAccountUsage}
                      onOpenTopUp={openAccountTopUp}
                    />
                  </>
                ) : null}
                {settingsState === undefined ? (
                  <p className="dsh-settings__empty" role="status">
                    {t('settings.loading')}
                  </p>
                ) : settingsState.value === undefined ? (
                  <p className="dsh-settings__empty" role="status">
                    {t('settings.unavailable')}
                  </p>
                ) : (
                  (() => {
                    const settings = settingsState.value
                    return (
                      <>
                        <dl className="dsh-settings__facts">
                          <dt>{t('settings.extensionVersion')}</dt>
                          <dd>{settings.extensionVersion}</dd>
                          <dt>{t('settings.connectionMode')}</dt>
                          <dd>{connectionModeLabel(settings.connection.mode, t)}</dd>
                          <dt>{t('settings.runtime')}</dt>
                          <dd>
                            {t(
                              settings.runtime.customExecutableConfigured
                                ? 'settings.runtimeCustom'
                                : 'settings.runtimeDiscovered',
                            )}
                          </dd>
                          <dt>{t('settings.dshVersion')}</dt>
                          <dd>
                            {props.connectedDshVersion ??
                              t(props.connected ? 'settings.versionUnavailable' : 'settings.notConnected')}
                          </dd>
                          <dt>{t('settings.permissionPreset')}</dt>
                          <dd>{settings.security.defaultPermissionPreset}</dd>
                          <dt>{t('settings.defaultAgent')}</dt>
                          <dd>
                            {settings.defaultAgent.model.providerId}/{settings.defaultAgent.model.modelId}
                          </dd>
                        </dl>
                        <SettingCard
                          ariaLabel={t('settings.connectionTitle')}
                          title={t('settings.connectionTitle')}
                          description={t('settings.connectionHint')}
                        >
                          <div
                            className="dsh-settings__connection-options"
                            role="radiogroup"
                            aria-label={t('settings.connectionMode')}
                          >
                            <label
                              className={`dsh-settings__connection-option${
                                connectionChoice === 'auto' ? ' dsh-settings__connection-option--active' : ''
                              }`}
                            >
                              <input
                                type="radio"
                                name="dsh-connection-mode"
                                value="auto"
                                checked={connectionChoice === 'auto'}
                                onChange={() => {
                                  setConnectionChoice('auto')
                                  setConnectionError(undefined)
                                  setConnectionNotice(undefined)
                                }}
                              />
                              <span>
                                <strong>{t('settings.automatic')}</strong>
                                <small>{t('settings.connectionAutoHint')}</small>
                              </span>
                            </label>
                            <label
                              className={`dsh-settings__connection-option${
                                connectionChoice === 'custom'
                                  ? ' dsh-settings__connection-option--active'
                                  : ''
                              }`}
                            >
                              <input
                                type="radio"
                                name="dsh-connection-mode"
                                value="custom"
                                checked={connectionChoice === 'custom'}
                                onChange={() => {
                                  setConnectionChoice('custom')
                                  setConnectionError(undefined)
                                  setConnectionNotice(undefined)
                                }}
                              />
                              <span>
                                <strong>{t('settings.connectionCustom')}</strong>
                                <small>{t('settings.connectionCustomHint')}</small>
                              </span>
                            </label>
                          </div>
                          {connectionChoice === 'custom' ? (
                            <label className="dsh-settings__connection-endpoint">
                              <span>{t('settings.connectionEndpoint')}</span>
                              <input
                                type="text"
                                inputMode="url"
                                value={connectionEndpoint}
                                placeholder={
                                  settings.connection.customEndpointConfigured
                                    ? t('settings.connectionEndpointConfigured')
                                    : t('settings.connectionEndpointPlaceholder')
                                }
                                onChange={(event) => {
                                  setConnectionEndpoint(event.target.value)
                                  setConnectionError(undefined)
                                  setConnectionNotice(undefined)
                                }}
                              />
                            </label>
                          ) : null}
                          {connectionChoice === 'unchanged' ? (
                            <p className="dsh-settings__connection-notice">
                              {t('settings.connectionUnchangedHint')}
                            </p>
                          ) : null}
                          <div className="dsh-settings__connection-actions">
                            <button
                              className="dsh-button dsh-button--primary dsh-button--compact"
                              type="button"
                              disabled={connectionBusy || connectionChoice === 'unchanged'}
                              onClick={applyConnection}
                            >
                              {connectionBusy
                                ? t('settings.connectionApplying')
                                : t('settings.connectionApply')}
                            </button>
                          </div>
                          {connectionError === undefined ? null : (
                            <p className="dsh-settings__error" role="alert">
                              {connectionError}
                            </p>
                          )}
                          {connectionNotice === undefined ? null : (
                            <p className="dsh-settings__connection-notice" role="status">
                              {connectionNotice}
                            </p>
                          )}
                        </SettingCard>
                      </>
                    )
                  })()
                )}
                {onCheckDshUpdates !== undefined && onInstallDshVersion !== undefined ? (
                  <section className="dsh-settings__runtime-update" aria-label={t('settings.dshUpdateTitle')}>
                    <div className="dsh-settings__runtime-update-head">
                      <div>
                        <h3>{t('settings.dshUpdateTitle')}</h3>
                        <p>{t('settings.dshUpdateHint')}</p>
                      </div>
                      <button
                        className="dsh-button dsh-button--secondary dsh-button--compact dsh-settings__runtime-update-check"
                        type="button"
                        disabled={dshUpdateBusy !== undefined}
                        onClick={checkDshUpdates}
                      >
                        {dshUpdateBusy === 'check'
                          ? t('settings.dshUpdateChecking')
                          : t('settings.dshUpdateCheck')}
                      </button>
                    </div>
                    {dshUpdate === undefined ? (
                      <p className="dsh-settings__empty" role="status">
                        {t('settings.dshUpdateLoading')}
                      </p>
                    ) : dshUpdate.status === 'unavailable' ? (
                      <p className="dsh-settings__error" role="alert">
                        {dshUpdateFailureMessage(dshUpdate.failure, t)}
                      </p>
                    ) : (
                      <>
                        {dshUpdateBusy !== undefined ? (
                          <div
                            className="dsh-settings__runtime-update-progress"
                            role="status"
                            aria-live="polite"
                          >
                            <div className="dsh-settings__runtime-update-progress-head">
                              <span>{dshUpdateProgressLabel(dshUpdateBusy, dshUpdateProgress, t)}</span>
                              <span>
                                {t('settings.dshUpdateProgressStage', {
                                  current: dshUpdateProgressStage(dshUpdateBusy, dshUpdateProgress),
                                  total: DSH_UPDATE_PROGRESS_TOTAL_STAGES,
                                })}
                              </span>
                            </div>
                            <div
                              className="dsh-settings__runtime-update-progress-track"
                              role="progressbar"
                              aria-label={t('settings.dshUpdateProgressLabel')}
                              aria-valuemin={0}
                              aria-valuemax={DSH_UPDATE_PROGRESS_TOTAL_STAGES}
                              aria-valuenow={dshUpdateProgressStage(dshUpdateBusy, dshUpdateProgress)}
                              aria-valuetext={dshUpdateProgressLabel(dshUpdateBusy, dshUpdateProgress, t)}
                            >
                              {Array.from({ length: DSH_UPDATE_PROGRESS_TOTAL_STAGES }, (_, index) => {
                                const stage = index + 1
                                const current = dshUpdateProgressStage(dshUpdateBusy, dshUpdateProgress)
                                return (
                                  <span
                                    className={`dsh-settings__runtime-update-progress-step${
                                      stage < current
                                        ? ' dsh-settings__runtime-update-progress-step--complete'
                                        : ''
                                    }${stage === current ? ' dsh-settings__runtime-update-progress-step--active' : ''}`}
                                    key={stage}
                                  />
                                )
                              })}
                            </div>
                          </div>
                        ) : null}
                        <dl className="dsh-settings__runtime-update-facts">
                          <dt>{t('settings.dshUpdateCurrent')}</dt>
                          <dd>{dshUpdate.currentVersion ?? t('settings.dshUpdateNotInstalled')}</dd>
                          <dt>{t('settings.dshUpdateGlobal')}</dt>
                          <dd>{dshUpdate.globalVersion ?? t('settings.dshUpdateNotInstalled')}</dd>
                          <dt>{t('settings.dshUpdateLatest')}</dt>
                          <dd>{dshUpdate.latestVersion ?? t('settings.dshUpdateUnavailable')}</dd>
                        </dl>
                        {dshUpdate.updateAvailable ? (
                          <p className="dsh-settings__runtime-update-notice" role="status">
                            {t('settings.dshUpdateAvailable', {
                              version: dshUpdate.latestVersion ?? '—',
                            })}
                          </p>
                        ) : null}
                        {selectedDshVersionAlreadyInstalled ? (
                          <p className="dsh-settings__runtime-update-notice" role="status">
                            {t('settings.dshUpdateAlreadyInstalled', {
                              version: effectiveSelectedDshVersion,
                            })}
                          </p>
                        ) : null}
                        <div className="dsh-settings__runtime-update-controls">
                          <span>{t('settings.dshUpdateVersion')}</span>
                          <SelectMenu
                            className="dsh-settings__runtime-update-version"
                            icon="refresh"
                            density="regular"
                            displayLabel
                            label={effectiveSelectedDshVersion ?? t('settings.dshUpdateUnavailable')}
                            ariaLabel={t('settings.dshUpdateVersion')}
                            title={t('settings.dshUpdateVersion')}
                            value={effectiveSelectedDshVersion ?? ''}
                            disabled={dshUpdateBusy !== undefined}
                            options={availableDshVersions.map((version) => ({
                              value: version,
                              label: version,
                            }))}
                            placement="below"
                            onChange={setSelectedDshVersion}
                          />
                          <button
                            className="dsh-button dsh-button--primary dsh-button--compact"
                            type="button"
                            disabled={
                              dshUpdateBusy !== undefined ||
                              effectiveSelectedDshVersion === undefined ||
                              selectedDshVersionAlreadyInstalled ||
                              availableDshVersions.length === 0
                            }
                            onClick={installDshVersion}
                          >
                            {selectedDshVersionAlreadyInstalled
                              ? t('settings.dshUpdateInstalled')
                              : dshUpdateBusy === 'install'
                                ? t('settings.dshUpdateInstalling')
                                : t('settings.dshUpdateInstall')}
                          </button>
                        </div>
                        {dshUpdate.restartRequired ? (
                          <p className="dsh-settings__note">{t('settings.dshUpdateRestart')}</p>
                        ) : null}
                        {dshUpdateError === undefined ? null : (
                          <p className="dsh-settings__error" role="alert">
                            {dshUpdateError}
                          </p>
                        )}
                      </>
                    )}
                  </section>
                ) : null}
                <SettingCard
                  ariaLabel={t('settings.extensionPreferences')}
                  title={t('settings.extensionPreferences')}
                >
                  <SettingRow
                    title={t('settings.language.label')}
                    description={t('settings.language.hint')}
                    control={
                      <div
                        className="dsh-settings__segment"
                        role="group"
                        aria-label={t('settings.language.label')}
                      >
                        {LOCALE_OPTIONS.map((option) => (
                          <button
                            key={option}
                            className={`dsh-settings__segment-item${
                              option === props.locale ? ' dsh-settings__segment-item--active' : ''
                            }`}
                            type="button"
                            aria-pressed={option === props.locale}
                            disabled={option === props.locale}
                            onClick={() => props.onLocaleChange(option)}
                          >
                            {option === 'zh' ? t('locale.chinese') : t('locale.english')}
                          </button>
                        ))}
                      </div>
                    }
                  />
                </SettingCard>
                <SettingCard ariaLabel={t('settings.preferences')} title={t('settings.preferences')}>
                  {dshState.status === 'loading' ? (
                    <p className="dsh-settings__empty" role="status">
                      {t('settings.loadingDsh')}
                    </p>
                  ) : dshState.status === 'unavailable' ? (
                    <>
                      <p className="dsh-settings__empty">{t('settings.dshUnavailable')}</p>
                      <button
                        className="dsh-button dsh-button--secondary dsh-button--compact"
                        type="button"
                        onClick={retryDshSettings}
                      >
                        {t('runtime.retry')}
                      </button>
                    </>
                  ) : !hasPreferencesContent(dshState.snapshot) ? (
                    // A schema that advertises none of these rows must not read as
                    // a broken card: state what the host offers instead of an
                    // empty titled box.
                    <p className="dsh-settings__empty">{t('settings.preferencesEmpty')}</p>
                  ) : (
                    <>
                      {!dshState.snapshot.schema.writable ? (
                        <p className="dsh-settings__empty" role="status">
                          {t('settings.readOnly')}
                        </p>
                      ) : null}
                      {!dshSettingsSnapshotFresh ? (
                        <div className="dsh-settings__empty" role="status">
                          <p>{t('settings.revisionRefreshRequired')}</p>
                          <button
                            className="dsh-button dsh-button--secondary dsh-button--compact"
                            type="button"
                            onClick={retryDshSettings}
                          >
                            {t('runtime.retry')}
                          </button>
                        </div>
                      ) : null}
                      <ul className="dsh-settings__rows">
                        {visibleGeneralRows(dshState.snapshot).map((row) => (
                          <GeneralSettingRow
                            key={row.path}
                            row={{
                              path: row.path,
                              label: t(row.labelKey),
                              hint: t(row.hintKey),
                              ...(row.defaultValue === undefined ? {} : { defaultValue: row.defaultValue }),
                            }}
                            fields={dshState.snapshot.schema.fields}
                            values={dshState.snapshot.values}
                            writable={dshState.snapshot.schema.writable}
                            selectedValue={row.path === 'ui-theme.preference' ? props.theme : undefined}
                            saving={savingPath === row.path}
                            disabled={
                              !dshState.snapshot.schema.writable ||
                              savingPath !== undefined ||
                              !dshSettingsSnapshotFresh
                            }
                            riskPending={riskPending?.path === row.path ? riskPending : undefined}
                            riskAcknowledged={riskAcknowledged}
                            onPick={(value) => {
                              if (isRiskValue(value)) {
                                setRiskAcknowledged(false)
                                setRiskPending({ path: row.path, value })
                                return
                              }
                              saveSetting(row.path, value)
                            }}
                            onConfirmRisk={() => {
                              if (riskPending === undefined || !riskAcknowledged) return
                              saveSetting(riskPending.path, riskPending.value)
                            }}
                            onRiskAcknowledgedChange={setRiskAcknowledged}
                            onCancelRisk={() => {
                              setRiskAcknowledged(false)
                              setRiskPending(undefined)
                            }}
                          />
                        ))}
                      </ul>
                      {renderCodingToolsSetting(
                        dshState.snapshot,
                        dshUiPreferences?.codingToolsEnabled,
                        savingPath,
                        dshSettingsSnapshotFresh,
                        (value) => saveSetting(DSH_UI_SETTING_PATHS.codingTools, value),
                        t,
                      )}
                      {saveError === undefined ? null : (
                        <p className="dsh-settings__error" role="alert">
                          {saveError}
                        </p>
                      )}
                    </>
                  )}
                </SettingCard>
                <SettingCard
                  ariaLabel={t('settings.conversationAppearance')}
                  title={t('settings.conversationAppearance')}
                >
                  {dshState.status === 'ready' &&
                  findDshSettingsField(dshState.snapshot, DSH_UI_SETTING_PATHS.fontSize)?.type === 'number' &&
                  !dshState.snapshot.schema.writable ? null : (
                    <SettingRow
                      title={t('settings.conversationFontSize')}
                      description={t('settings.conversationFontSizeHint')}
                      control={renderFontSizeControl(
                        dshState,
                        dshUiPreferences?.fontSize,
                        props.conversationFontSize,
                        savingPath,
                        dshSettingsSnapshotFresh,
                        saveError,
                        (value) => saveSetting(DSH_UI_SETTING_PATHS.fontSize, value),
                        props.onConversationFontSizeChange,
                        t,
                      )}
                    />
                  )}
                </SettingCard>
                <p className="dsh-settings__note">{t('settings.hostNote')}</p>
                {dshState.status === 'ready' && dshState.snapshot.schema.hasDocument ? (
                  <div className="dsh-settings__document-action">
                    <button
                      className="dsh-button dsh-button--secondary dsh-button--compact"
                      type="button"
                      disabled={busyField !== undefined}
                      onClick={openSettingsDocument}
                    >
                      <Icon name="file" />
                      {t('settings.openDocument')}
                    </button>
                    {documentError === undefined ? null : (
                      <span className="dsh-settings__error" role="alert">
                        {documentError}
                      </span>
                    )}
                  </div>
                ) : null}
                <SettingCard
                  ariaLabel={t('settings.keyboardShortcuts')}
                  title={t('settings.keyboardShortcuts')}
                >
                  <p className="dsh-settings__description">{t('settings.keyboardShortcutsHint')}</p>
                  <div className="dsh-settings__document-action">
                    <button
                      className="dsh-button dsh-button--secondary dsh-button--compact"
                      type="button"
                      disabled={busyField !== undefined}
                      onClick={openKeyboardShortcuts}
                    >
                      {t('settings.keyboardShortcutsOpen')}
                    </button>
                    {keyboardShortcutsError === undefined ? null : (
                      <span className="dsh-settings__error" role="alert">
                        {keyboardShortcutsError}
                      </span>
                    )}
                  </div>
                </SettingCard>
              </div>
            ) : tab === 'models' ? (
              <div
                className="dsh-settings__body"
                id="dsh-settings-panel-models"
                role="tabpanel"
                aria-labelledby="dsh-settings-tab-models"
                aria-label={t('settings.modelsAria')}
              >
                <div className="dsh-settings__toolbar">
                  <span className="dsh-settings__summary">
                    {t(
                      orderedProviderRows.length === 1
                        ? 'settings.providerCount'
                        : 'settings.providerCountPlural',
                      { count: orderedProviderRows.length },
                    )}{' '}
                    ·{' '}
                    {t(props.models.length === 1 ? 'settings.modelCount' : 'settings.modelCountPlural', {
                      count: props.models.length,
                    })}
                  </span>
                  <button
                    className="dsh-icon-button"
                    type="button"
                    aria-label={t('settings.refreshCatalog')}
                    title={t('settings.refreshCatalog')}
                    disabled={busyField !== undefined}
                    onClick={() => {
                      if (busyField !== undefined) return
                      setSaveError(undefined)
                      setBusyField('refresh')
                      void props
                        .onRefreshCatalog()
                        .catch((reason: unknown) =>
                          setSaveError(reason instanceof Error ? reason.message : t('settings.updateFailed')),
                        )
                        .finally(() => setBusyField(undefined))
                    }}
                  >
                    <Icon name="refresh" />
                  </button>
                </div>
                {saveError === undefined ? null : (
                  <p className="dsh-settings__error" role="alert">
                    {saveError}
                  </p>
                )}
                {dshState.status === 'loading' ? (
                  <p className="dsh-settings__empty" role="status">
                    {t('settings.loadingDsh')}
                  </p>
                ) : orderedProviderRows.length === 0 ? (
                  <p className="dsh-settings__empty">{t('settings.noProviders')}</p>
                ) : (
                  <ul className="dsh-settings__providers">
                    {orderedProviderRows.map((provider) => {
                      const providerModels = modelsByProvider.get(provider.id) ?? []
                      const providerName =
                        provider.settingsNs === 'llm-deepseek-account'
                          ? t('settings.deepseekAccount')
                          : provider.name
                      const secretFields = provider.fields.filter((field) => field.secret)
                      const editable =
                        dshState.status === 'ready' &&
                        dshSettingsSnapshotFresh &&
                        provider.settingsNs !== undefined &&
                        provider.settingsNs.trim() !== ''
                      const isEditing = editingProviderId === provider.id
                      return (
                        <li className="dsh-settings__provider" key={provider.id}>
                          <div className="dsh-settings__provider-head">
                            <div className="dsh-settings__provider-identity">
                              <strong title={provider.id}>{providerName}</strong>
                              {provider.id === provider.name ? null : <code>{provider.id}</code>}
                              <span className="dsh-settings__provider-kind">{provider.kind}</span>
                              {provider.active === true ? (
                                <span
                                  className="dsh-settings__provider-active"
                                  title={t('settings.activeProvider')}
                                >
                                  {t('settings.active')}
                                </span>
                              ) : null}
                            </div>
                            <div className="dsh-settings__provider-actions">
                              {editable ? (
                                <button
                                  className="dsh-button dsh-button--secondary dsh-button--compact"
                                  type="button"
                                  disabled={
                                    !dshSettingsSnapshotFresh || (busyField !== undefined && !isEditing)
                                  }
                                  onClick={() => {
                                    setSaveError(undefined)
                                    setAddingCustomProvider(false)
                                    setAddingProviderId(undefined)
                                    setEditingProviderId(isEditing ? undefined : provider.id)
                                  }}
                                >
                                  {isEditing ? t('settings.closeEditor') : t('settings.editProvider')}
                                </button>
                              ) : null}
                              {(provider.settingsPath?.length ?? 0) > 0 ? (
                                <button
                                  className="dsh-button dsh-button--secondary dsh-button--compact dsh-settings__provider-remove"
                                  type="button"
                                  disabled={busyField !== undefined || !dshSettingsSnapshotFresh}
                                  onClick={(event) => {
                                    removeProviderTriggerRef.current = event.currentTarget
                                    setSaveError(undefined)
                                    setRemovingProviderId(provider.id)
                                  }}
                                >
                                  {t('settings.removeProvider')}
                                </button>
                              ) : null}
                            </div>
                          </div>
                          <div className="dsh-settings__provider-summary">
                            <span>
                              {t(
                                providerModels.length === 1
                                  ? 'settings.modelsSummary'
                                  : 'settings.modelsSummaryPlural',
                                { count: providerModels.length },
                              )}
                            </span>
                            {secretFields.map((field) => {
                              const key = `${provider.id}:${field.key}`
                              return (
                                <span className="dsh-settings__provider-credential" key={field.key}>
                                  <span
                                    className={`dsh-settings__field-state${field.value === undefined ? '' : ' dsh-settings__field-state--ok'}`}
                                  >
                                    <span
                                      className="dsh-settings__secret-dot"
                                      data-configured={field.value === undefined ? 'false' : 'true'}
                                      aria-hidden="true"
                                    />
                                    {field.value === undefined
                                      ? t('settings.missing')
                                      : t('settings.configured')}
                                  </span>
                                  <button
                                    className="dsh-button dsh-button--secondary dsh-button--compact"
                                    type="button"
                                    disabled={busyField !== undefined || field.writable === false}
                                    onClick={() =>
                                      runSecretAction(key, async () => {
                                        await props.onConfigureSecret(provider.id, field.key)
                                      })
                                    }
                                  >
                                    {field.value === undefined
                                      ? t('settings.configure')
                                      : t('settings.replace')}
                                  </button>
                                  {field.value === undefined ? null : (
                                    <button
                                      className="dsh-icon-button"
                                      type="button"
                                      aria-label={t('settings.removeSecret', {
                                        provider: provider.name,
                                        field: field.label,
                                      })}
                                      title={t('settings.removeSecretTitle')}
                                      disabled={busyField !== undefined || field.writable === false}
                                      onClick={() =>
                                        runSecretAction(key, async () => {
                                          await props.onRemoveSecret(provider.id, field.key)
                                        })
                                      }
                                    >
                                      <Icon name="close" />
                                    </button>
                                  )}
                                </span>
                              )
                            })}
                          </div>
                          {isEditing && dshState.status === 'ready' && provider.settingsNs !== undefined ? (
                            <ProviderSettingsEditor
                              provider={provider}
                              catalogModels={providerModels}
                              settings={dshState.snapshot}
                              writable={dshState.snapshot.schema.writable}
                              saving={busyField === `provider:${provider.id}`}
                              onSave={(changes, expectedRevision) =>
                                saveProviderChanges(provider, changes, expectedRevision)
                              }
                              onDiscover={props.onDiscoverModels}
                              onClose={(changed) => {
                                setEditingProviderId(undefined)
                                if (!changed) setSaveError(undefined)
                              }}
                            />
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                )}
                {addableProviders.length === 0 && !canAddCustomProvider ? null : (
                  <>
                    <div className="dsh-settings__provider-add-actions">
                      <button
                        className="dsh-settings__provider-add"
                        type="button"
                        disabled={
                          busyField !== undefined ||
                          dshState.status !== 'ready' ||
                          !dshSettingsSnapshotFresh ||
                          !dshState.snapshot.schema.writable ||
                          addableProviders.length === 0
                        }
                        onClick={() => {
                          const firstProvider = addableProviders[0]
                          if (firstProvider === undefined) return
                          setSaveError(undefined)
                          setEditingProviderId(undefined)
                          setAddingCustomProvider(false)
                          setAddingProviderId((current) =>
                            current === undefined ? firstProvider.id : undefined,
                          )
                        }}
                      >
                        <Icon name="add" />
                        {t('settings.addProvider')}
                      </button>
                      <button
                        className="dsh-settings__provider-add"
                        type="button"
                        disabled={
                          busyField !== undefined ||
                          dshState.status !== 'ready' ||
                          !dshSettingsSnapshotFresh ||
                          !dshState.snapshot.schema.writable ||
                          !canAddCustomProvider
                        }
                        onClick={() => {
                          setSaveError(undefined)
                          setEditingProviderId(undefined)
                          setAddingProviderId(undefined)
                          setAddingCustomProvider((current) => !current)
                        }}
                      >
                        <Icon name="add" />
                        {t('settings.addCustomProvider')}
                      </button>
                    </div>
                    {addingProvider === undefined || dshState.status !== 'ready' ? null : (
                      <section
                        className="dsh-settings__provider-add-card"
                        role="region"
                        aria-label={t('settings.addProvider')}
                      >
                        <div className="dsh-settings__provider-add-select">
                          <span>{t('settings.addProviderSelect')}</span>
                          <SelectMenu
                            className="dsh-settings__provider-add-picker"
                            icon="box"
                            density="regular"
                            label={addingProvider.name}
                            ariaLabel={t('settings.addProviderSelect')}
                            title={t('settings.addProviderSelect')}
                            value={addingProvider.id}
                            disabled={busyField !== undefined}
                            options={addableProviders.map((provider) => ({
                              value: provider.id,
                              label: provider.name,
                            }))}
                            placement="below"
                            align="start"
                            onChange={(value) => {
                              const next = addableProviders.find((provider) => provider.id === value)
                              if (next === undefined) return
                              setSaveError(undefined)
                              setAddingProviderId(next.id)
                            }}
                          />
                        </div>
                        <ProviderSettingsEditor
                          key={addingProvider.id}
                          provider={addingProvider}
                          settings={dshState.snapshot}
                          writable={dshState.snapshot.schema.writable}
                          saving={busyField === `provider:${addingProvider.id}`}
                          forceSave={(addingProvider.settingsPath?.length ?? 0) > 0}
                          onSave={(changes, expectedRevision) =>
                            saveProviderChanges(addingProvider, changes, expectedRevision, true)
                          }
                          onDiscover={props.onDiscoverModels}
                          onClose={(changed) => {
                            setAddingProviderId(undefined)
                            if (!changed) setSaveError(undefined)
                          }}
                        />
                      </section>
                    )}
                    {addingCustomProvider && customProviderTemplate !== undefined ? (
                      <CustomProviderCard
                        template={customProviderTemplate}
                        providers={props.providers}
                        writable={dshState.status === 'ready' && dshState.snapshot.schema.writable}
                        saving={busyField !== undefined}
                        onClose={(changed) => {
                          setAddingCustomProvider(false)
                          if (!changed) setSaveError(undefined)
                        }}
                        onCreate={saveCustomProvider}
                        onConfigureSecret={configureCustomProviderSecret}
                        onDiscover={props.onDiscoverCustomModels}
                      />
                    ) : null}
                  </>
                )}
                {pendingProvider === undefined ? null : (
                  <div
                    ref={removeDialogRef}
                    className="dsh-settings__provider-remove-dialog"
                    role="alertdialog"
                    aria-modal="true"
                    aria-label={t('settings.removeProvider')}
                  >
                    <h3>{t('settings.removeProviderHeading')}</h3>
                    <p>{t('settings.removeProviderPrompt', { provider: pendingProvider.name })}</p>
                    <div className="dsh-settings__risk-actions">
                      <button
                        className="dsh-button dsh-button--secondary dsh-button--compact"
                        type="button"
                        disabled={busyField !== undefined}
                        autoFocus
                        onClick={() => setRemovingProviderId(undefined)}
                      >
                        {t('settings.cancel')}
                      </button>
                      <button
                        className="dsh-button dsh-button--danger dsh-button--compact"
                        type="button"
                        disabled={busyField !== undefined}
                        onClick={() => void removeProvider(pendingProvider)}
                      >
                        {busyField === `remove-provider:${pendingProvider.id}`
                          ? t('settings.removingProvider')
                          : t('settings.removeProviderConfirm')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : tab === 'presets' ? (
              <div
                className="dsh-settings__body"
                id="dsh-settings-panel-presets"
                role="tabpanel"
                aria-labelledby="dsh-settings-tab-presets"
                aria-label={t('settings.presetsAria')}
              >
                <PresetManager
                  codingToolsEnabled={
                    dshState.status === 'ready' &&
                    dshSettingsSnapshotFresh &&
                    dshUiPreferences?.codingToolsEnabled === true
                  }
                  defaultWritable={
                    dshState.status === 'ready' &&
                    dshSettingsSnapshotFresh &&
                    dshState.snapshot.schema.writable
                  }
                  onLoadRoster={() => props.onLoadPresetRoster()}
                  onReadDocument={(presetId) => props.onReadPresetDocument(presetId)}
                  onCopy={(from, presetId, name) => props.onCopyPreset(from, presetId, name)}
                  onRemove={(presetId) => props.onRemovePreset(presetId)}
                  onOpenLocation={(presetId) => props.onOpenPresetDocument(presetId)}
                  {...(props.onStartCreatorDraft === undefined
                    ? {}
                    : { onStartCreatorDraft: props.onStartCreatorDraft })}
                  onMakeDefault={(presetId, settingsPath) =>
                    updateDisplayedSetting(settingsPath ?? 'agent-presets.default', presetId)
                  }
                />
              </div>
            ) : (
              <div
                className="dsh-settings__body"
                id="dsh-settings-panel-plugins"
                role="tabpanel"
                aria-labelledby="dsh-settings-tab-plugins"
                aria-label={t('settings.pluginsAria')}
              >
                <PluginConfiguration
                  snapshot={
                    dshState.status === 'ready' && dshSettingsSnapshotFresh ? dshState.snapshot : undefined
                  }
                  onReload={async () => {
                    try {
                      const snapshot = await props.onLoadDshSettings()
                      if (snapshot !== undefined) {
                        setDshState({ status: 'ready', snapshot })
                        setDshSettingsSnapshotFresh(true)
                      } else {
                        setDshState({ status: 'unavailable' })
                        setDshSettingsSnapshotFresh(false)
                      }
                      return snapshot
                    } catch (reason: unknown) {
                      setDshState({ status: 'unavailable' })
                      setDshSettingsSnapshotFresh(false)
                      throw reason
                    }
                  }}
                  onMutateSettings={props.onMutateDshSettings}
                  onConfigureCredential={props.onConfigurePluginCredential}
                  onRemoveCredential={props.onRemovePluginCredential}
                />
                <PluginInventory
                  revision={props.pluginInventoryRevision}
                  onLoadInventory={() => props.onLoadPluginInventory()}
                />
                {props.featureRequest === undefined ? null : (
                  <OptionalBundleManager
                    revision={props.pluginInventoryRevision ?? 0}
                    {...(props.pluginInstallProgress === undefined
                      ? {}
                      : { installProgress: props.pluginInstallProgress })}
                    {...(props.pluginInstallOperation === undefined
                      ? {}
                      : { installOperation: props.pluginInstallOperation })}
                    {...(props.onStartPluginInstall === undefined
                      ? {}
                      : { onStartInstall: props.onStartPluginInstall })}
                    {...(props.onCancelPluginInstall === undefined
                      ? {}
                      : { onCancelInstall: props.onCancelPluginInstall })}
                    {...(props.onRecoverPluginInstall === undefined
                      ? {}
                      : { onRecoverInstall: props.onRecoverPluginInstall })}
                    featureRequest={props.featureRequest}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </section>
    </ModalWrapper>
  )
}

function accountProfileLabels(t: Translate): AccountProfileLabels {
  return {
    title: t('account.profile.title'),
    refresh: t('account.profile.refresh'),
    profile: t('account.profile.profile'),
    balance: t('account.profile.balance'),
    bonusBalance: t('account.profile.bonusBalance'),
    bonusNotice: t('account.profile.bonusNotice'),
    signedOut: t('account.signedOut'),
    unavailable: t('account.profile.unavailable'),
    failed: t('account.profile.failed'),
    noBalance: t('account.profile.noBalance'),
    unnamed: t('account.profile.unnamed'),
    dismissBonus: t('account.profile.dismissBonus'),
    retryBonus: t('account.profile.retryBonus'),
    usage: t('account.profile.usage'),
    topUp: t('account.profile.topUp'),
  }
}

function accountLifecycleLabels(t: Translate): AccountLifecycleLabels {
  const phases: Record<AccountLifecycleUiPhase, string> = {
    initializing: t('account.phase.initializing'),
    'waiting-browser': t('account.phase.waitingBrowser'),
    exchanging: t('account.phase.exchanging'),
    committing: t('account.phase.committing'),
    succeeded: t('account.phase.succeeded'),
    cancelled: t('account.phase.cancelled'),
    expired: t('account.phase.expired'),
    failed: t('account.phase.failed'),
  }
  const errors: Record<AccountLifecycleUiError, string> = {
    network: t('account.error.network'),
    protocol: t('account.error.protocol'),
    expired: t('account.error.expired'),
    storage: t('account.error.storage'),
  }
  return {
    title: t('account.title'),
    loading: t('account.loading'),
    signedOut: t('account.signedOut'),
    credentialStored: t('account.credentialStored'),
    signIn: t('account.signIn'),
    cancelSignIn: t('account.cancelSignIn'),
    checkSignOutImpact: t('account.checkSignOutImpact'),
    signOut: t('account.signOut'),
    sessionExpired: t('account.sessionExpired'),
    requestFailed: t('account.requestFailed'),
    retry: t('account.retry'),
    phases,
    errors,
    hostErrors: {
      'state-stream-failed': t('account.hostError.stateStream'),
      'expiry-stream-failed': t('account.hostError.expiryStream'),
      'browser-open-failed': t('account.hostError.browserOpen'),
    },
    impacts: {
      none: t('account.impact.none'),
      running: t('account.impact.running'),
      unknown: t('account.impact.unknown'),
    },
  }
}

function deriveCustomProviderTemplate(
  providers: readonly ModelProvider[],
  settings: DshSettingsSnapshot,
): CustomProviderTemplate | undefined {
  const candidate = providers.find((provider) => {
    if (
      provider.settingsNs === undefined ||
      provider.settingsNs.trim() === '' ||
      provider.settingsPath === undefined ||
      provider.settingsPath.length < 2
    )
      return false
    const namespace = settings.schema.namespaces.find((entry) => entry.ns === provider.settingsNs)
    const protocols = provider.fields.find((field) => field.key === 'api')?.enumValues
    return namespace !== undefined && protocols !== undefined && protocols.length > 0
  })
  if (candidate?.settingsNs === undefined || candidate.settingsPath === undefined) return undefined
  const namespace = settings.schema.namespaces.find((entry) => entry.ns === candidate.settingsNs)
  const protocols = uniqueStrings(candidate.fields.find((field) => field.key === 'api')?.enumValues)
  if (namespace === undefined || protocols.length === 0) return undefined
  const profilePath = [candidate.settingsNs, ...candidate.settingsPath].join('.')
  const profile = settingValueAt(settings.values, profilePath)
  const configuredApi =
    typeof profile === 'object' && profile !== null && !Array.isArray(profile)
      ? (profile as Record<string, unknown>).api
      : undefined
  return {
    settingsNamespace: candidate.settingsNs,
    collectionPath: candidate.settingsPath.slice(0, -1),
    protocols,
    revision: namespace.revision,
    ...(typeof configuredApi === 'string' && protocols.includes(configuredApi) ? { api: configuredApi } : {}),
  }
}

function uniqueStrings(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return []
  return [...new Set(values.filter((value) => value.trim() !== ''))]
}

/** Hide dormant directory entries; the upstream page lists configured rows only. */
function isConfiguredProvider(provider: ModelProvider, settings: DshSettingsSnapshot): boolean {
  const namespace = provider.settingsNs?.trim()
  if (namespace === undefined || namespace === '') {
    // Older DSH versions did not expose a settings address. Keep their rows
    // visible so the compatibility fallback still exposes credential actions.
    return true
  }
  // Match the official ModelsSection store: a provider is listed only when
  // its namespace exists and its configured profile exists. `active` is a
  // runtime routing fact, not evidence that a dormant catalog entry has a
  // user profile.
  const namespaceValue = settingValueAt(settings.values, namespace)
  if (namespaceValue === undefined) return false
  const settingsPath = provider.settingsPath ?? []
  if (settingsPath.length === 0) return true
  if (typeof namespaceValue !== 'object' || namespaceValue === null || Array.isArray(namespaceValue))
    return false
  return (
    settingValueAt(namespaceValue as Readonly<Record<string, unknown>>, settingsPath.join('.')) !== undefined
  )
}

function providerRowOrder(provider: ModelProvider): number {
  if (provider.id === 'deepseek-account') return 0
  if (provider.id === 'deepseek-official' || provider.settingsNs === 'llm-deepseek') return 1
  return 2
}

function isAddableProvider(provider: ModelProvider, settings: DshSettingsSnapshot): boolean {
  if (provider.configurable === false || isConfiguredProvider(provider, settings)) return false
  const namespace = provider.settingsNs?.trim()
  const settingsPath = provider.settingsPath
  // A whole-section provider (for example the shipped DeepSeek namespace) is
  // also an upstream-supported setup target. Its editor writes individual
  // fields below the namespace; nested provider profiles can additionally be
  // materialized as an empty object on Apply.
  return (
    namespace !== undefined &&
    namespace !== '' &&
    settingsPath !== undefined &&
    settingsPath.every((part) => part.trim() !== '')
  )
}

function namespaceInPath(path: string): string {
  return path.split('.', 1)[0] ?? ''
}

function settingsNamespaceRevision(snapshot: DshSettingsSnapshot, namespace: string): number | undefined {
  return snapshot.schema.namespaces.find((entry) => entry.ns === namespace)?.revision
}

function providerSettingOperations(
  provider: ModelProvider,
  changes: readonly ProviderSettingChange[],
): readonly SettingsPathOperation[] | undefined {
  const namespace = provider.settingsNs?.trim()
  if (namespace === undefined || namespace === '') return undefined
  const prefix = [namespace, ...(provider.settingsPath ?? [])]
  const operations: SettingsPathOperation[] = []
  for (const change of changes) {
    const path = change.path.split('.')
    if (
      path.length <= prefix.length ||
      !prefix.every((segment, index) => path[index] === segment) ||
      path.some((segment) => segment.trim() === '')
    )
      return undefined
    const relativePath = path.slice(prefix.length)
    operations.push(
      change.kind === 'set'
        ? { op: 'set', path: relativePath, value: change.value }
        : { op: 'unset', path: relativePath },
    )
  }
  return operations
}

function isSettingsConflict(reason: unknown): boolean {
  return (
    typeof reason === 'object' && reason !== null && 'code' in reason && reason.code === 'SETTINGS_CONFLICT'
  )
}

function isKnownRejectedSettingsWrite(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    'code' in reason &&
    (reason.code === 'INVALID_CONFIGURATION' ||
      reason.code === 'PERMISSION_DENIED' ||
      reason.code === 'CAPABILITY_UNAVAILABLE')
  )
}

function isValidGeneralSettingChange(snapshot: DshSettingsSnapshot, path: string, value: unknown): boolean {
  const field = findDshSettingsField(snapshot, path)
  if (field === undefined || !snapshot.schema.writable) return false
  if (path === DSH_UI_SETTING_PATHS.codingTools) return field.type === 'boolean' && typeof value === 'boolean'
  if (path === DSH_UI_SETTING_PATHS.fontSize)
    return field.type === 'number' && isConversationFontSizePx(value)
  if (field.type !== 'enum' || typeof value !== 'string' || !field.enumValues?.includes(value)) return false
  if (path === DSH_UI_SETTING_PATHS.transcriptView) return isTranscriptViewMode(value)
  if (path === DSH_UI_SETTING_PATHS.performanceUsage) return isPerformanceUsageMode(value)
  return true
}

function renderCodingToolsSetting(
  snapshot: DshSettingsSnapshot,
  value: boolean | undefined,
  savingPath: string | undefined,
  snapshotFresh: boolean,
  onChange: (value: boolean) => void,
  t: Translate,
): ReactElement | null {
  const field = findDshSettingsField(snapshot, DSH_UI_SETTING_PATHS.codingTools)
  if (field?.type !== 'boolean' || !snapshot.schema.writable) return null
  const label = t('settings.codingTools.label')
  const saving = savingPath === DSH_UI_SETTING_PATHS.codingTools
  const enabled = value === true
  return (
    <SettingRow
      title={label}
      description={t('settings.codingTools.hint')}
      status={
        <>
          {field.restartRequired ? (
            <span className="dsh-setting-row__status-note" title={t('settings.restartTitle')}>
              {t('settings.restart')}
            </span>
          ) : null}
          {saving ? (
            <span className="dsh-setting-row__status-saving" role="status">
              {t('settings.saving')}
            </span>
          ) : null}
        </>
      }
      control={
        <button
          className="dsh-settings__switch"
          type="button"
          role="switch"
          aria-label={label}
          aria-checked={enabled}
          disabled={!snapshot.schema.writable || savingPath !== undefined || !snapshotFresh}
          onClick={() => onChange(!enabled)}
        >
          <span aria-hidden="true" />
        </button>
      }
    />
  )
}

function renderFontSizeControl(
  dshState: DshSettingsState,
  hostFontSize: number | undefined,
  localFontSize: ConversationFontSize,
  savingPath: string | undefined,
  snapshotFresh: boolean,
  error: string | undefined,
  onHostChange: (value: number) => void,
  onLocalChange: (value: ConversationFontSize) => void,
  t: Translate,
): ReactElement {
  const field =
    dshState.status === 'ready'
      ? findDshSettingsField(dshState.snapshot, DSH_UI_SETTING_PATHS.fontSize)
      : undefined
  if (dshState.status === 'ready' && field?.type === 'number') {
    return (
      <FontSizeSettingControl
        key={`${hostFontSize ?? DEFAULT_CONVERSATION_FONT_SIZE_PX}:${error ?? ''}:${savingPath === DSH_UI_SETTING_PATHS.fontSize ? 'saving' : 'idle'}`}
        value={hostFontSize ?? DEFAULT_CONVERSATION_FONT_SIZE_PX}
        disabled={!dshState.snapshot.schema.writable || savingPath !== undefined || !snapshotFresh}
        saving={savingPath === DSH_UI_SETTING_PATHS.fontSize}
        error={error}
        onCommit={onHostChange}
        translate={t}
      />
    )
  }
  return (
    <div className="dsh-settings__segment" role="group" aria-label={t('settings.conversationFontSize')}>
      {CONVERSATION_FONT_SIZE_OPTIONS.map((size) => (
        <button
          key={size}
          className={`dsh-settings__segment-item${
            size === localFontSize ? ' dsh-settings__segment-item--active' : ''
          }`}
          type="button"
          aria-pressed={size === localFontSize}
          disabled={size === localFontSize}
          onClick={() => onLocalChange(size)}
        >
          {t(`settings.value.${size}`)}
        </button>
      ))}
    </div>
  )
}

interface FontSizeSettingControlProps {
  readonly value: number
  readonly disabled: boolean
  readonly saving: boolean
  readonly error: string | undefined
  readonly onCommit: (value: number) => void
  readonly translate: Translate
}

function FontSizeSettingControl(props: FontSizeSettingControlProps): ReactElement {
  const [draft, setDraft] = useState(String(props.value))

  const commit = (): void => {
    const value = Number(draft)
    if (isConversationFontSizePx(value)) {
      if (value !== props.value) props.onCommit(value)
      return
    }
    setDraft(String(props.value))
  }

  return (
    <div className="dsh-settings__number-control">
      <input
        className="dsh-settings__number-input"
        type="number"
        min={MIN_CONVERSATION_FONT_SIZE_PX}
        max={MAX_CONVERSATION_FONT_SIZE_PX}
        step={1}
        aria-label={props.translate('settings.conversationFontSize')}
        aria-busy={props.saving}
        disabled={props.disabled}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
      />
      <span>{props.translate('settings.pixels')}</span>
    </div>
  )
}

interface GeneralSettingRowProps {
  readonly row: {
    readonly path: string
    readonly label: string
    readonly hint: string
    readonly defaultValue?: string
  }
  readonly fields: readonly DshSettingsSchema['fields'][number][]
  readonly values: Readonly<Record<string, unknown>>
  readonly writable: boolean
  readonly selectedValue?: string | undefined
  readonly saving: boolean
  readonly disabled: boolean
  readonly riskPending: RiskPending | undefined
  readonly riskAcknowledged: boolean
  readonly onPick: (value: string) => void
  readonly onConfirmRisk: () => void
  readonly onRiskAcknowledgedChange: (acknowledged: boolean) => void
  readonly onCancelRisk: () => void
}

/** One official General row: renders only when the host schema advertises the
 * field, and only as a segmented enum picker (the upstream General section is
 * exclusively enum-valued rows). */
type GeneralSettingRowDefinition = (typeof GENERAL_SETTING_ROWS)[number]

/** Mirror of `GeneralSettingRow`'s own render guard: a row is visible when the
 * host schema advertises its field as a non-empty enum, minus the read-only
 * transcript rows the component suppresses. Keeping the predicate beside the
 * component lets the section state when it has nothing to show at all. */
function isGeneralRowVisible(snapshot: DshSettingsSnapshot, row: GeneralSettingRowDefinition): boolean {
  const field = snapshot.schema.fields.find((entry) => entry.path === row.path)
  if (field?.type !== 'enum' || (field.enumValues?.length ?? 0) === 0) return false
  return !(
    !snapshot.schema.writable &&
    (row.path === DSH_UI_SETTING_PATHS.transcriptView || row.path === DSH_UI_SETTING_PATHS.performanceUsage)
  )
}

function visibleGeneralRows(snapshot: DshSettingsSnapshot): readonly GeneralSettingRowDefinition[] {
  return GENERAL_SETTING_ROWS.filter((row) => isGeneralRowVisible(snapshot, row))
}

/** Whether this card has any content beyond its title for this host schema. */
function hasPreferencesContent(snapshot: DshSettingsSnapshot): boolean {
  return (
    GENERAL_SETTING_ROWS.some((row) => isGeneralRowVisible(snapshot, row)) ||
    findDshSettingsField(snapshot, DSH_UI_SETTING_PATHS.codingTools)?.type === 'boolean'
  )
}

function GeneralSettingRow(props: GeneralSettingRowProps): ReactElement | null {
  const { t } = useI18n()
  const field = props.fields.find((entry) => entry.path === props.row.path)
  if (
    !props.writable &&
    (props.row.path === DSH_UI_SETTING_PATHS.transcriptView ||
      props.row.path === DSH_UI_SETTING_PATHS.performanceUsage)
  )
    return null
  const options = field?.enumValues?.filter((option) => {
    if (props.row.path === DSH_UI_SETTING_PATHS.transcriptView) return isTranscriptViewMode(option)
    if (props.row.path === DSH_UI_SETTING_PATHS.performanceUsage) return isPerformanceUsageMode(option)
    return true
  })
  if (field?.type !== 'enum' || options === undefined || options.length === 0) return null
  const savedValue = settingValueAt(props.values, props.row.path)
  const normalizedSavedValue =
    props.row.path === DSH_UI_SETTING_PATHS.transcriptView
      ? savedValue === 'normal'
        ? 'standard'
        : savedValue === 'expanded'
          ? 'detailed'
          : savedValue
      : savedValue
  const candidate = props.selectedValue ?? normalizedSavedValue ?? props.row.defaultValue
  const currentLabel =
    typeof candidate === 'string' && options.includes(candidate)
      ? candidate
      : props.row.defaultValue !== undefined && options.includes(props.row.defaultValue)
        ? props.row.defaultValue
        : options[0]
  return (
    <SettingRow
      as="li"
      title={props.row.label}
      description={props.row.hint}
      status={
        <>
          {field.restartRequired ? (
            <span className="dsh-setting-row__status-note" title={t('settings.restartTitle')}>
              {t('settings.restart')}
            </span>
          ) : null}
          {props.saving ? (
            <span className="dsh-setting-row__status-saving" role="status">
              {t('settings.saving')}
            </span>
          ) : null}
        </>
      }
      control={
        <div className="dsh-settings__segment" role="group" aria-label={props.row.label}>
          {options.map((option) => (
            <button
              key={option}
              className={`dsh-settings__segment-item${
                option === currentLabel ? ' dsh-settings__segment-item--active' : ''
              }`}
              type="button"
              aria-pressed={option === currentLabel}
              disabled={props.disabled || option === currentLabel}
              onClick={() => props.onPick(option)}
            >
              {formatSettingValue(option, t)}
            </button>
          ))}
        </div>
      }
      footer={
        props.riskPending === undefined ? undefined : (
          <div className="dsh-settings__risk" role="alertdialog" aria-label={t('settings.fullAccessAria')}>
            <span>{t('settings.fullAccessPrompt')}</span>
            <label>
              <input
                type="checkbox"
                checked={props.riskAcknowledged}
                disabled={props.disabled}
                onChange={(event) => props.onRiskAcknowledgedChange(event.currentTarget.checked)}
              />
              {t('settings.fullAccessAck')}
            </label>
            <div className="dsh-settings__risk-actions">
              <button
                className="dsh-button dsh-button--danger dsh-button--compact"
                type="button"
                disabled={props.disabled || !props.riskAcknowledged}
                onClick={props.onConfirmRisk}
              >
                {t('settings.fullAccessConfirm')}
              </button>
              <button
                className="dsh-button dsh-button--secondary dsh-button--compact"
                type="button"
                disabled={props.disabled}
                onClick={props.onCancelRisk}
              >
                {t('settings.cancel')}
              </button>
            </div>
          </div>
        )
      }
    />
  )
}

function dshUpdateFailureMessage(failure: DshUpdateSnapshot['failure'], t: Translate): string {
  switch (failure) {
    case 'npm-not-found':
      return t('settings.dshUpdateNpmMissing')
    case 'invalid-response':
      return t('settings.dshUpdateInvalidResponse')
    case 'registry-unavailable':
      return t('settings.dshUpdateRegistryUnavailable')
    default:
      return t('settings.dshUpdateUnavailable')
  }
}

function dshUpdateProgressLabel(
  busy: 'check' | 'install',
  progress: DshRuntimeUpdateProgress | undefined,
  t: Translate,
): string {
  switch (progress?.phase) {
    case 'checking':
      return t('settings.dshUpdateProgressChecking')
    case 'downloading':
      return t('settings.dshUpdateProgressDownloading')
    case 'installing':
      return t('settings.dshUpdateProgressInstalling')
    case 'verifying':
      return t('settings.dshUpdateProgressVerifying')
    case 'completed':
      return t('settings.dshUpdateProgressCompleted')
    case 'failed':
      return t('settings.dshUpdateProgressFailed')
    default:
      return busy === 'check'
        ? t('settings.dshUpdateProgressChecking')
        : t('settings.dshUpdateProgressDownloading')
  }
}

const DSH_UPDATE_PROGRESS_TOTAL_STAGES = 4

function dshUpdateProgressStage(
  busy: 'check' | 'install' | undefined,
  progress: DshRuntimeUpdateProgress | undefined,
): number {
  switch (progress?.phase) {
    case 'checking':
      return 1
    case 'downloading':
    case 'installing':
      return 2
    case 'verifying':
      return 3
    case 'completed':
      return 4
    case 'failed':
      return busy === 'check' ? 1 : 2
    default:
      return busy === 'check' ? 1 : 2
  }
}

function connectionModeLabel(mode: ExtensionSettingsSummary['connection']['mode'], t: Translate): string {
  if (mode === 'auto') return t('settings.automatic')
  if (mode === 'custom') return t('settings.connectionCustom')
  return mode
}

function settingValueAt(values: Readonly<Record<string, unknown>>, path: string): unknown {
  let cursor: unknown = values
  for (const part of path.split('.')) {
    const record =
      typeof cursor === 'object' && cursor !== null && !Array.isArray(cursor)
        ? (cursor as Record<string, unknown>)
        : undefined
    if (record === undefined) return undefined
    cursor = record[part]
  }
  return cursor
}

function withSettingValue(snapshot: DshSettingsSnapshot, path: string, value: unknown): DshSettingsSnapshot {
  const segments = path.split('.')
  if (segments.length === 0 || segments.some((segment) => segment.trim() === '')) return snapshot
  const update = (current: unknown, index: number): Record<string, unknown> => {
    const record =
      typeof current === 'object' && current !== null && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : {}
    const key = segments[index]
    if (key === undefined) return record
    return {
      ...record,
      [key]: index === segments.length - 1 ? value : update(record[key], index + 1),
    }
  }
  return { ...snapshot, values: update(snapshot.values, 0) }
}

function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'zh'
}

/** Same permission label formatting the session controls use. */
function formatSettingValue(value: string, t: (key: string) => string): string {
  const localized = new Set([
    'danger-full-access',
    'workspace-write',
    'read-only',
    'en',
    'zh',
    'light',
    'dark',
    'system',
    'queue',
    'steer',
    'compact',
    'standard',
    'detailed',
    'verbose',
  ])
  if (localized.has(value)) return t(`settings.value.${value}`)
  if (!value.includes('-')) return value
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
