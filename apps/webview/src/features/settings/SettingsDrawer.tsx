import { useEffect, useRef, useState, type ReactElement } from 'react'
import type {
  AgentPresetDocument,
  AgentPresetLocation,
  AgentPresetRoster,
  DshSettingsSchema,
  DshRuntimeUpdateProgress,
  DshUpdateSnapshot,
  DiscoveredModel,
  ExtensionSettingsSummary,
  ModelDescriptor,
  ModelDiscoveryInput,
  ModelProvider,
  PluginInventorySnapshot,
} from '@dsh-vscode/domain'
import type { DshSettingsSnapshot } from '../../app/store.js'
import { Icon } from '../../ui/Icon.js'
import { PluginInventory } from '../plugins/PluginInventory.js'
import { PresetManager } from './PresetManager.js'
import { CustomProviderCard, type CustomProviderTemplate } from './CustomProviderCard.js'
import { ProviderSettingsEditor, type ProviderSettingChange } from './ProviderSettingsEditor.js'
import { useI18n, type Translate } from '../../i18n.js'

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
  readonly providers: readonly ModelProvider[]
  readonly models: readonly ModelDescriptor[]
  readonly onLoadSettings: () => Promise<ExtensionSettingsSummary | undefined>
  readonly onLoadDshSettings: () => Promise<DshSettingsSnapshot | undefined>
  readonly onOpenDshSettingsDocument: () => Promise<void>
  readonly onUpdateDshSetting: (path: string, value: unknown) => Promise<void>
  readonly onUnsetDshSetting: (path: string) => Promise<void>
  readonly onDiscoverModels: (
    input: Omit<ModelDiscoveryInput, 'apiKey'>,
  ) => Promise<readonly DiscoveredModel[]>
  readonly onConfigureSecret: (providerId: string, field: string) => Promise<boolean>
  readonly onRemoveSecret: (providerId: string, field: string) => Promise<void>
  readonly onRefreshCatalog: () => Promise<void>
  readonly onLoadPresetRoster: () => Promise<AgentPresetRoster | undefined>
  readonly onReadPresetDocument: (presetId: string) => Promise<AgentPresetDocument | undefined>
  readonly onCopyPreset: (from: string, presetId: string, name?: string) => Promise<string | undefined>
  readonly onRemovePreset: (presetId: string) => Promise<void>
  readonly onOpenPresetDocument: (presetId: string) => Promise<AgentPresetLocation | undefined>
  readonly onStartCreatorDraft?: () => Promise<void>
  readonly onLoadPluginInventory: () => Promise<PluginInventorySnapshot | undefined>
}

type SettingsTab = 'general' | 'models' | 'presets' | 'plugins'
type ConnectionChoice = 'auto' | 'custom'

const SETTINGS_TABS: readonly SettingsTab[] = ['general', 'models', 'presets', 'plugins']

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
}[] = [
  {
    path: 'permission.defaultPreset',
    labelKey: 'settings.permission.label',
    hintKey: 'settings.permission.hint',
  },
  {
    path: 'locale.preference',
    labelKey: 'settings.language.label',
    hintKey: 'settings.language.hint',
  },
  {
    path: 'ui-theme.preference',
    labelKey: 'settings.appearance.label',
    hintKey: 'settings.appearance.hint',
  },
  {
    path: 'ui-conversation.busyEnter',
    labelKey: 'settings.enter.label',
    hintKey: 'settings.enter.hint',
  },
]

/** Upstream RiskConfirmation tier: values that grant unrestricted tools. */
function isRiskValue(value: string): boolean {
  return value === 'danger-full-access'
}

export function SettingsDrawer(props: SettingsDrawerProps): ReactElement {
  const { t } = useI18n()
  const {
    open,
    dshUpdate,
    dshUpdateProgress,
    onCheckDshUpdates,
    onInstallDshVersion,
    onLoadSettings,
    onLoadDshSettings,
    onUpdateDshSetting,
    onOpenChange,
  } = props
  const [tab, setTab] = useState<SettingsTab>('general')
  const [settingsState, setSettingsState] = useState<LoadedSettings | undefined>(undefined)
  const [dshState, setDshState] = useState<DshSettingsState>({ status: 'loading' })
  const [savingPath, setSavingPath] = useState<string | undefined>(undefined)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [riskPending, setRiskPending] = useState<RiskPending | undefined>(undefined)
  const [riskAcknowledged, setRiskAcknowledged] = useState(false)
  const [busyField, setBusyField] = useState<string | undefined>(undefined)
  const [documentError, setDocumentError] = useState<string | undefined>(undefined)
  const [dshUpdateBusy, setDshUpdateBusy] = useState<'check' | 'install' | undefined>(undefined)
  const [dshUpdateError, setDshUpdateError] = useState<string | undefined>(undefined)
  const [selectedDshVersion, setSelectedDshVersion] = useState<string | undefined>(undefined)
  const dshUpdateCheckStarted = useRef(false)
  const [editingProviderId, setEditingProviderId] = useState<string | undefined>(undefined)
  const [addingCustomProvider, setAddingCustomProvider] = useState(false)
  const [removingProviderId, setRemovingProviderId] = useState<string | undefined>(undefined)
  const [connectionChoice, setConnectionChoice] = useState<ConnectionChoice>('auto')
  const [connectionEndpoint, setConnectionEndpoint] = useState('')
  const [connectionBusy, setConnectionBusy] = useState(false)
  const [connectionError, setConnectionError] = useState<string | undefined>(undefined)
  const [connectionNotice, setConnectionNotice] = useState<string | undefined>(undefined)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    if (settingsState !== undefined) return
    let cancelled = false
    void onLoadSettings()
      .catch(() => undefined)
      .then((value) => {
        if (cancelled) return
        setSettingsState({ value })
        if (value !== undefined) {
          setConnectionChoice(value.connection.mode === 'custom' ? 'custom' : 'auto')
          setConnectionEndpoint('')
          setConnectionError(undefined)
          setConnectionNotice(undefined)
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, onLoadSettings, settingsState])

  useEffect(() => {
    if (!open || dshState.status !== 'loading') return
    let cancelled = false
    void onLoadDshSettings()
      .catch(() => undefined)
      .then((snapshot) => {
        if (!cancelled)
          setDshState(snapshot === undefined ? { status: 'unavailable' } : { status: 'ready', snapshot })
      })
    return () => {
      cancelled = true
    }
  }, [open, onLoadDshSettings, dshState.status])

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
    setSaveError(undefined)
    setRiskPending(undefined)
    setRiskAcknowledged(false)
    setSavingPath(path)
    void onUpdateDshSetting(path, value)
      .catch((reason: unknown) => {
        setSaveError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
        return undefined
      })
      .then(() =>
        // Reload either way: a revision conflict must surface the host's
        // authoritative value instead of the stale local pick.
        onLoadDshSettings()
          .catch(() => undefined)
          .then((snapshot) => {
            if (snapshot !== undefined) setDshState({ status: 'ready', snapshot })
          }),
      )
      .finally(() => setSavingPath(undefined))
  }

  const applyConnection = (): void => {
    if (connectionBusy) return
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

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onOpenChange(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onOpenChange])

  if (!open) return <></>

  const availableDshVersions = dshUpdate?.availableVersions ?? []
  const effectiveSelectedDshVersion =
    selectedDshVersion !== undefined && availableDshVersions.includes(selectedDshVersion)
      ? selectedDshVersion
      : (dshUpdate?.latestVersion ?? availableDshVersions[0])

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
  ): Promise<void> => {
    if (busyField !== undefined) throw new Error(t('settings.updateFailed'))
    setSaveError(undefined)
    setBusyField(`provider:${provider.id}`)
    try {
      for (const change of changes) {
        if (change.kind === 'set') await onUpdateDshSetting(change.path, change.value)
        else await props.onUnsetDshSetting(change.path)
      }
      const snapshot = await onLoadDshSettings()
      if (snapshot !== undefined) setDshState({ status: 'ready', snapshot })
      await props.onRefreshCatalog()
    } catch (reason: unknown) {
      setSaveError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
      throw reason
    } finally {
      setBusyField(undefined)
    }
  }

  const saveCustomProvider = async (
    path: string,
    value: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    if (busyField !== undefined) throw new Error(t('settings.updateFailed'))
    setSaveError(undefined)
    setBusyField(`provider:${path}`)
    try {
      await onUpdateDshSetting(path, value)
      const snapshot = await onLoadDshSettings()
      if (snapshot !== undefined) setDshState({ status: 'ready', snapshot })
      await props.onRefreshCatalog()
    } catch (reason: unknown) {
      setSaveError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
      throw reason
    } finally {
      setBusyField(undefined)
    }
  }

  const removeProvider = async (provider: ModelProvider): Promise<void> => {
    if (busyField !== undefined || provider.settingsNs === undefined || provider.settingsPath === undefined)
      return
    setSaveError(undefined)
    setBusyField(`remove-provider:${provider.id}`)
    try {
      for (const field of provider.fields) {
        if (!field.secret || field.value === undefined || field.writable === false) continue
        await props.onRemoveSecret(provider.id, field.key)
      }
      await props.onUnsetDshSetting([provider.settingsNs, ...provider.settingsPath].join('.'))
      setRemovingProviderId(undefined)
      setEditingProviderId(undefined)
      const snapshot = await onLoadDshSettings()
      if (snapshot !== undefined) setDshState({ status: 'ready', snapshot })
      await props.onRefreshCatalog()
    } catch (reason: unknown) {
      setSaveError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
    } finally {
      setBusyField(undefined)
    }
  }

  const customProviderTemplate: CustomProviderTemplate | undefined =
    dshState.status === 'ready' ? deriveCustomProviderTemplate(props.providers, dshState.snapshot) : undefined
  const providerRows =
    dshState.status === 'ready'
      ? props.providers.filter((provider) => isConfiguredProvider(provider, dshState.snapshot))
      : dshState.status === 'unavailable'
        ? props.providers
        : []
  const pendingProvider =
    removingProviderId === undefined
      ? undefined
      : props.providers.find((provider) => provider.id === removingProviderId)

  return (
    <div
      className="dsh-settings__backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onOpenChange(false)
      }}
    >
      <section className="dsh-settings" role="dialog" aria-modal="true" aria-label={t('settings.title')}>
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
          <nav className="dsh-settings__tabs" role="tablist" aria-label={t('settings.sections')}>
            {SETTINGS_TABS.map((entry) => (
              <button
                key={entry}
                id={`dsh-settings-tab-${entry}`}
                className={`dsh-settings__tab${tab === entry ? ' dsh-settings__tab--active' : ''}`}
                type="button"
                role="tab"
                aria-selected={tab === entry}
                aria-controls={`dsh-settings-panel-${entry}`}
                tabIndex={tab === entry ? 0 : -1}
                onClick={() => setTab(entry)}
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
                {settingsState === undefined ? (
                  <p className="dsh-settings__empty" role="status">
                    {t('settings.loading')}
                  </p>
                ) : settingsState.value === undefined ? (
                  <p className="dsh-settings__empty">{t('settings.unavailable')}</p>
                ) : (
                  (() => {
                    const settings = settingsState.value
                    return (
                      <>
                        <dl className="dsh-settings__facts">
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
                        <section
                          className="dsh-settings__connection"
                          aria-label={t('settings.connectionTitle')}
                        >
                          <div className="dsh-settings__connection-head">
                            <h3>{t('settings.connectionTitle')}</h3>
                            <p>{t('settings.connectionHint')}</p>
                          </div>
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
                          <div className="dsh-settings__connection-actions">
                            <button
                              className="dsh-button dsh-button--primary dsh-button--compact"
                              type="button"
                              disabled={connectionBusy}
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
                        </section>
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
                        className="dsh-button dsh-button--ghost dsh-button--compact"
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
                            <progress
                              className="dsh-settings__runtime-update-progress-bar"
                              max={100}
                              aria-label={t('settings.dshUpdateProgressLabel')}
                            />
                            <span>{dshUpdateProgressLabel(dshUpdateBusy, dshUpdateProgress, t)}</span>
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
                        <div className="dsh-settings__runtime-update-controls">
                          <label htmlFor="dsh-settings-update-version">
                            {t('settings.dshUpdateVersion')}
                          </label>
                          <select
                            id="dsh-settings-update-version"
                            value={effectiveSelectedDshVersion ?? ''}
                            disabled={dshUpdateBusy !== undefined || availableDshVersions.length === 0}
                            onChange={(event) => setSelectedDshVersion(event.target.value)}
                          >
                            {availableDshVersions.map((version) => (
                              <option key={version} value={version}>
                                {version}
                              </option>
                            ))}
                          </select>
                          <button
                            className="dsh-button dsh-button--primary dsh-button--compact"
                            type="button"
                            disabled={
                              dshUpdateBusy !== undefined ||
                              effectiveSelectedDshVersion === undefined ||
                              availableDshVersions.length === 0
                            }
                            onClick={installDshVersion}
                          >
                            {dshUpdateBusy === 'install'
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
                <section className="dsh-settings__preferences" aria-label={t('settings.preferences')}>
                  <h3>{t('settings.preferences')}</h3>
                  {dshState.status === 'loading' ? (
                    <p className="dsh-settings__empty" role="status">
                      {t('settings.loadingDsh')}
                    </p>
                  ) : dshState.status === 'unavailable' ? (
                    <p className="dsh-settings__empty">{t('settings.dshUnavailable')}</p>
                  ) : (
                    <>
                      {!dshState.snapshot.schema.writable ? (
                        <p className="dsh-settings__empty" role="status">
                          {t('settings.readOnly')}
                        </p>
                      ) : null}
                      <ul className="dsh-settings__rows">
                        {GENERAL_SETTING_ROWS.map((row) => (
                          <GeneralSettingRow
                            key={row.path}
                            row={{
                              path: row.path,
                              label: t(row.labelKey),
                              hint: t(row.hintKey),
                            }}
                            fields={dshState.snapshot.schema.fields}
                            values={dshState.snapshot.values}
                            saving={savingPath === row.path}
                            disabled={!dshState.snapshot.schema.writable || savingPath !== undefined}
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
                      {saveError === undefined ? null : (
                        <p className="dsh-settings__error" role="alert">
                          {saveError}
                        </p>
                      )}
                    </>
                  )}
                </section>
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
                      providerRows.length === 1 ? 'settings.providerCount' : 'settings.providerCountPlural',
                      { count: providerRows.length },
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
                ) : providerRows.length === 0 ? (
                  <p className="dsh-settings__empty">{t('settings.noProviders')}</p>
                ) : (
                  <ul className="dsh-settings__providers">
                    {providerRows.map((provider) => {
                      const providerModels = modelsByProvider.get(provider.id) ?? []
                      const secretFields = provider.fields.filter((field) => field.secret)
                      const editable =
                        dshState.status === 'ready' &&
                        provider.settingsNs !== undefined &&
                        provider.settingsNs.trim() !== ''
                      const isEditing = editingProviderId === provider.id
                      return (
                        <li className="dsh-settings__provider" key={provider.id}>
                          <div className="dsh-settings__provider-head">
                            <div className="dsh-settings__provider-identity">
                              <strong title={provider.id}>{provider.name}</strong>
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
                                  disabled={busyField !== undefined && !isEditing}
                                  onClick={() => {
                                    setSaveError(undefined)
                                    setAddingCustomProvider(false)
                                    setEditingProviderId(isEditing ? undefined : provider.id)
                                  }}
                                >
                                  {isEditing ? t('settings.closeEditor') : t('settings.editProvider')}
                                </button>
                              ) : null}
                              {(provider.settingsPath?.length ?? 0) > 0 ? (
                                <button
                                  className="dsh-button dsh-button--danger dsh-button--compact"
                                  type="button"
                                  disabled={busyField !== undefined}
                                  onClick={() => {
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
                              settings={dshState.snapshot}
                              writable={dshState.snapshot.schema.writable}
                              saving={busyField === `provider:${provider.id}`}
                              onSave={(changes) => saveProviderChanges(provider, changes)}
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
                {customProviderTemplate === undefined ? null : (
                  <>
                    <div className="dsh-settings__provider-add-actions">
                      <button
                        className="dsh-settings__provider-add"
                        type="button"
                        disabled={
                          busyField !== undefined ||
                          dshState.status !== 'ready' ||
                          !dshState.snapshot.schema.writable
                        }
                        onClick={() => {
                          setEditingProviderId(undefined)
                          setAddingCustomProvider((current) => !current)
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
                          !dshState.snapshot.schema.writable
                        }
                        onClick={() => {
                          setEditingProviderId(undefined)
                          setAddingCustomProvider(true)
                        }}
                      >
                        <Icon name="add" />
                        {t('settings.addCustomProvider')}
                      </button>
                    </div>
                    {addingCustomProvider ? (
                      <CustomProviderCard
                        template={customProviderTemplate}
                        providers={props.providers}
                        writable={dshState.status === 'ready' && dshState.snapshot.schema.writable}
                        saving={busyField !== undefined}
                        onSave={saveCustomProvider}
                        onDiscover={props.onDiscoverModels}
                      />
                    ) : null}
                  </>
                )}
                {pendingProvider === undefined ? null : (
                  <div
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
                  defaultWritable={dshState.status === 'ready' && dshState.snapshot.schema.writable}
                  onLoadRoster={() => props.onLoadPresetRoster()}
                  onReadDocument={(presetId) => props.onReadPresetDocument(presetId)}
                  onCopy={(from, presetId, name) => props.onCopyPreset(from, presetId, name)}
                  onRemove={(presetId) => props.onRemovePreset(presetId)}
                  onOpenLocation={(presetId) => props.onOpenPresetDocument(presetId)}
                  {...(props.onStartCreatorDraft === undefined
                    ? {}
                    : { onStartCreatorDraft: props.onStartCreatorDraft })}
                  onMakeDefault={(presetId) =>
                    // The upstream default is the `agent-presets.default` settings
                    // field — the same revision-guarded write the General rows use.
                    props.onUpdateDshSetting('agent-presets.default', presetId)
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
                <PluginInventory onLoadInventory={() => props.onLoadPluginInventory()} />
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

function deriveCustomProviderTemplate(
  providers: readonly ModelProvider[],
  settings: DshSettingsSnapshot,
): CustomProviderTemplate | undefined {
  const candidate = providers.find(
    (provider) =>
      provider.settingsNs !== undefined &&
      provider.settingsNs.trim() !== '' &&
      provider.settingsPath !== undefined &&
      provider.settingsPath.length >= 2,
  )
  if (candidate?.settingsNs === undefined || candidate.settingsPath === undefined) return undefined
  const profilePath = [candidate.settingsNs, ...candidate.settingsPath].join('.')
  const profile = settingValueAt(settings.values, profilePath)
  const api =
    typeof profile === 'object' && profile !== null && !Array.isArray(profile)
      ? (profile as Record<string, unknown>).api
      : undefined
  return {
    settingsNamespace: candidate.settingsNs,
    collectionPath: candidate.settingsPath.slice(0, -1),
    ...(typeof api === 'string' && api.trim() !== '' ? { api } : {}),
  }
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

interface GeneralSettingRowProps {
  readonly row: { readonly path: string; readonly label: string; readonly hint: string }
  readonly fields: readonly DshSettingsSchema['fields'][number][]
  readonly values: Readonly<Record<string, unknown>>
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
function GeneralSettingRow(props: GeneralSettingRowProps): ReactElement | null {
  const { t } = useI18n()
  const field = props.fields.find((entry) => entry.path === props.row.path)
  const options = field?.enumValues
  if (field === undefined || options === undefined || options.length === 0) return null
  const current = settingValueAt(props.values, props.row.path)
  const currentLabel = typeof current === 'string' ? current : undefined
  return (
    <li className="dsh-settings__row">
      <div className="dsh-settings__row-head">
        <span className="dsh-settings__row-label">{props.row.label}</span>
        {field.restartRequired ? (
          <span className="dsh-settings__row-note" title={t('settings.restartTitle')}>
            {t('settings.restart')}
          </span>
        ) : null}
        {props.saving ? (
          <span className="dsh-settings__row-saving" role="status">
            {t('settings.saving')}
          </span>
        ) : null}
      </div>
      <p className="dsh-settings__row-hint">{props.row.hint}</p>
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
      {props.riskPending === undefined ? null : (
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
      )}
    </li>
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
  ])
  if (localized.has(value)) return t(`settings.value.${value}`)
  if (!value.includes('-')) return value
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
