import { useEffect, useRef, useState, type ReactElement } from 'react'
import type {
  AgentPresetDocument,
  AgentPresetLocation,
  AgentPresetRoster,
  DshSettingsSchema,
  ExtensionSettingsSummary,
  ModelDescriptor,
  ModelProvider,
  PluginInventorySnapshot,
} from '@dsh-vscode/domain'
import type { DshSettingsSnapshot } from '../../app/store.js'
import { Icon } from '../../ui/Icon.js'
import { PluginInventory } from '../plugins/PluginInventory.js'
import { PresetManager } from './PresetManager.js'
import { useI18n } from '../../i18n.js'

export interface SettingsDrawerProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly connected: boolean
  readonly connectedDshVersion: string | undefined
  readonly providers: readonly ModelProvider[]
  readonly models: readonly ModelDescriptor[]
  readonly onLoadSettings: () => Promise<ExtensionSettingsSummary | undefined>
  readonly onLoadDshSettings: () => Promise<DshSettingsSnapshot | undefined>
  readonly onUpdateDshSetting: (path: string, value: unknown) => Promise<void>
  readonly onConfigureSecret: (providerId: string, field: string) => Promise<boolean>
  readonly onRemoveSecret: (providerId: string, field: string) => Promise<void>
  readonly onRefreshCatalog: () => Promise<void>
  readonly onLoadPresetRoster: () => Promise<AgentPresetRoster | undefined>
  readonly onReadPresetDocument: (presetId: string) => Promise<AgentPresetDocument | undefined>
  readonly onCopyPreset: (from: string, presetId: string, name?: string) => Promise<string | undefined>
  readonly onRemovePreset: (presetId: string) => Promise<void>
  readonly onOpenPresetDocument: (presetId: string) => Promise<AgentPresetLocation | undefined>
  readonly onLoadPluginInventory: () => Promise<PluginInventorySnapshot | undefined>
}

type SettingsTab = 'general' | 'models' | 'presets' | 'plugins'

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
  const { open, onLoadSettings, onLoadDshSettings, onUpdateDshSetting, onOpenChange } = props
  const [tab, setTab] = useState<SettingsTab>('general')
  const [settingsState, setSettingsState] = useState<LoadedSettings | undefined>(undefined)
  const [dshState, setDshState] = useState<DshSettingsState>({ status: 'loading' })
  const [savingPath, setSavingPath] = useState<string | undefined>(undefined)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [riskPending, setRiskPending] = useState<RiskPending | undefined>(undefined)
  const [riskAcknowledged, setRiskAcknowledged] = useState(false)
  const [busyField, setBusyField] = useState<string | undefined>(undefined)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    if (settingsState !== undefined) return
    let cancelled = false
    void onLoadSettings()
      .catch(() => undefined)
      .then((value) => {
        if (!cancelled) setSettingsState({ value })
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
        <div className="dsh-settings__tabs" role="tablist" aria-label={t('settings.sections')}>
          {(['general', 'models', 'presets', 'plugins'] as const).map((entry) => (
            <button
              key={entry}
              className={`dsh-settings__tab${tab === entry ? ' dsh-settings__tab--active' : ''}`}
              type="button"
              role="tab"
              aria-selected={tab === entry}
              onClick={() => setTab(entry)}
            >
              {t(`settings.${entry}`)}
            </button>
          ))}
        </div>
        {tab === 'general' ? (
          <div className="dsh-settings__body" role="tabpanel" aria-label={t('settings.generalAria')}>
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
                  <dl className="dsh-settings__facts">
                    <dt>{t('settings.connectionMode')}</dt>
                    <dd>{settings.connection.mode}</dd>
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
                )
              })()
            )}
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
          </div>
        ) : tab === 'models' ? (
          <div className="dsh-settings__body" role="tabpanel" aria-label={t('settings.modelsAria')}>
            <div className="dsh-settings__toolbar">
              <span className="dsh-settings__summary">
                {t(props.providers.length === 1 ? 'settings.providerCount' : 'settings.providerCountPlural', {
                  count: props.providers.length,
                })}{' '}
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
            {props.providers.length === 0 ? (
              <p className="dsh-settings__empty">{t('settings.noProviders')}</p>
            ) : (
              <ul className="dsh-settings__providers">
                {props.providers.map((provider) => (
                  <li className="dsh-settings__provider" key={provider.id}>
                    <div className="dsh-settings__provider-head">
                      <strong title={provider.id}>{provider.name}</strong>
                      <span className="dsh-settings__provider-kind">{provider.kind}</span>
                      {provider.active === true ? (
                        <span className="dsh-settings__provider-active" title={t('settings.activeProvider')}>
                          {t('settings.active')}
                        </span>
                      ) : null}
                    </div>
                    {provider.fields.length === 0 ? null : (
                      <ul className="dsh-settings__fields">
                        {provider.fields.map((field) => {
                          const key = `${provider.id}:${field.key}`
                          return (
                            <li className="dsh-settings__field" key={field.key}>
                              <span className="dsh-settings__field-label" title={field.key}>
                                {field.label}
                              </span>
                              {field.secret ? (
                                <>
                                  <span
                                    className={`dsh-settings__field-state${
                                      field.value === undefined ? '' : ' dsh-settings__field-state--ok'
                                    }`}
                                  >
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
                                </>
                              ) : (
                                <span className="dsh-settings__field-value">
                                  {field.value ?? t('settings.notSet')}
                                </span>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                    <ProviderModels models={modelsByProvider.get(provider.id) ?? []} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : tab === 'presets' ? (
          <div className="dsh-settings__body" role="tabpanel" aria-label={t('settings.presetsAria')}>
            <PresetManager
              defaultWritable={dshState.status === 'ready' && dshState.snapshot.schema.writable}
              onLoadRoster={() => props.onLoadPresetRoster()}
              onReadDocument={(presetId) => props.onReadPresetDocument(presetId)}
              onCopy={(from, presetId, name) => props.onCopyPreset(from, presetId, name)}
              onRemove={(presetId) => props.onRemovePreset(presetId)}
              onOpenLocation={(presetId) => props.onOpenPresetDocument(presetId)}
              onMakeDefault={(presetId) =>
                // The upstream default is the `agent-presets.default` settings
                // field — the same revision-guarded write the General rows use.
                props.onUpdateDshSetting('agent-presets.default', presetId)
              }
            />
          </div>
        ) : (
          <div className="dsh-settings__body" role="tabpanel" aria-label={t('settings.pluginsAria')}>
            <PluginInventory onLoadInventory={() => props.onLoadPluginInventory()} />
          </div>
        )}
      </section>
    </div>
  )
}

function ProviderModels(props: { readonly models: readonly ModelDescriptor[] }): ReactElement | null {
  const { t } = useI18n()
  if (props.models.length === 0) return null
  return (
    <details className="dsh-settings__models">
      <summary>{t('settings.modelsSummary', { count: props.models.length })}</summary>
      <ul>
        {props.models.map((model) => (
          <li key={model.id} title={model.id}>
            <span className="dsh-settings__model-label">{model.label}</span>
            <span className="dsh-settings__model-meta">
              {model.contextWindow === undefined
                ? t('settings.unknownContext')
                : t('settings.context', { count: Math.round(model.contextWindow / 1000) })}
              {model.supportsReasoning ? ` · ${t('settings.reasoning')}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </details>
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
