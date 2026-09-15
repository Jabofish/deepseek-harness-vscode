import { useState, type ReactElement } from 'react'
import type { DiscoveredModel, ModelDiscoveryInput, ModelProvider } from '@dsh-vscode/domain'
import type { DshSettingsSnapshot } from '../../app/store.js'
import { useI18n, type Translate } from '../../i18n.js'
import { SelectMenu } from '../../components/common/SelectMenu.js'
import { ModelListEditor, type EditableModel } from './ModelListEditor.js'

export type ProviderSettingChange =
  | { readonly kind: 'set'; readonly path: string; readonly value: unknown }
  | { readonly kind: 'unset'; readonly path: string }

export interface ProviderSettingsEditorProps {
  readonly provider: ModelProvider
  readonly settings: DshSettingsSnapshot
  readonly writable: boolean
  readonly saving: boolean
  /** Materialize a dormant catalog provider even when no field changed yet. */
  readonly forceSave?: boolean
  readonly onSave: (changes: readonly ProviderSettingChange[]) => Promise<void>
  readonly onDiscover: (input: Omit<ModelDiscoveryInput, 'apiKey'>) => Promise<readonly DiscoveredModel[]>
  readonly onClose: (changed: boolean) => void
}

interface ProviderFieldRef {
  readonly key: string
  readonly value: string
  readonly enumValues?: readonly string[]
}

/**
 * The small, schema-aware provider editor used by the VS Code carrier.
 *
 * It intentionally exposes only the fields the upstream page exposes for the
 * two shipped LLM families. Unknown namespaces remain usable as rows and are
 * directed to the host-owned document instead of receiving guessed controls.
 */
export function ProviderSettingsEditor(props: ProviderSettingsEditorProps): ReactElement {
  const { t } = useI18n()
  const settingsNs = props.provider.settingsNs?.trim() ?? ''
  const settingsPath = props.provider.settingsPath ?? []
  const prefix = settingsNs === '' ? [] : [settingsNs, ...settingsPath]
  const profile = settingValueAt(props.settings.values, prefix)
  const baseField = stringField(props.provider, /base.?url/iu)
  const apiField = stringField(props.provider, /^api$/iu)
  const baseUrlPath = baseField === undefined ? undefined : [...prefix, baseField.key].join('.')
  const apiPath = apiField === undefined ? undefined : [...prefix, apiField.key].join('.')
  const modelsPath = [...prefix, 'models'].join('.')
  const modelsSchema = props.settings.schema.fields.find((field) => field.path === modelsPath)
  const hasModelList =
    modelsSchema?.type === 'array' ||
    Array.isArray(settingValueAt(props.settings.values, [...prefix, 'models']))
  const supported = settingsNs === 'llm-deepseek' || settingsNs === 'llm-pi-ai'
  const initialBaseUrl = baseField?.value ?? stringAt(profile, 'baseURL') ?? ''
  const initialApi = apiField?.value ?? stringAt(profile, 'api') ?? ''
  const initialModels = hasModelList
    ? modelListAt(settingValueAt(props.settings.values, [...prefix, 'models']))
    : []
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl)
  const [api, setApi] = useState(initialApi)
  const [models, setModels] = useState<EditableModel[]>(() => initialModels.map(copyModel))
  const [error, setError] = useState<string | undefined>(undefined)

  const disabled = !props.writable || props.saving
  const apiOptions =
    apiField?.enumValues === undefined || apiField.enumValues.length === 0
      ? []
      : [
          ...(api === '' ? [{ value: '', label: t('settings.notSet') }] : []),
          ...(api !== '' && !apiField.enumValues.includes(api) ? [{ value: api, label: api }] : []),
          ...apiField.enumValues.map((value) => ({ value, label: value })),
        ]
  const discoveryInput: Omit<ModelDiscoveryInput, 'apiKey'> = {
    settingsNamespace: settingsNs,
    providerId: props.provider.id,
    ...(baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
    ...(api.trim() === '' ? {} : { api: api.trim() }),
  }

  const save = async (): Promise<void> => {
    if (disabled) return
    setError(undefined)
    const normalizedModels = models.map((model) => ({
      ...model,
      id: model.id.trim(),
      ...(model.name === undefined || model.name.trim() === '' ? {} : { name: model.name.trim() }),
    }))
    const modelFailure = validateModels(normalizedModels)
    if (modelFailure !== undefined) {
      setError(modelFailureMessage(modelFailure, t))
      return
    }
    const changes: ProviderSettingChange[] = []
    addOptionalChange(changes, baseUrlPath, baseUrl, initialBaseUrl)
    addOptionalChange(changes, apiPath, api, initialApi)
    if (hasModelList && JSON.stringify(normalizedModels) !== JSON.stringify(initialModels)) {
      changes.push({ kind: 'set', path: modelsPath, value: normalizedModels })
    }
    if (changes.length === 0 && props.forceSave !== true) {
      props.onClose(false)
      return
    }
    try {
      await props.onSave(changes)
      props.onClose(true)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
    }
  }

  return (
    <div className="dsh-settings__provider-editor">
      <header className="dsh-settings__provider-editor-head">
        <div>
          <strong>{props.provider.name}</strong>
          {props.provider.id === props.provider.name ? null : <code>{props.provider.id}</code>}
        </div>
        <span className="dsh-settings__provider-editor-scope">{settingsNs}</span>
      </header>
      {!supported ? (
        <p className="dsh-settings__advanced-hint">
          {t('settings.providerAdvancedHint', { namespace: settingsNs })}
        </p>
      ) : (
        <>
          {baseUrlPath === undefined && apiPath === undefined && !hasModelList ? (
            <p className="dsh-settings__advanced-hint">{t('settings.providerNoEditableFields')}</p>
          ) : null}
          {baseUrlPath === undefined ? null : (
            <label className="dsh-settings__provider-editor-field">
              <span>{t('settings.providerBaseUrl')}</span>
              <input
                type="url"
                value={baseUrl}
                disabled={disabled}
                placeholder={settingsNs === 'llm-deepseek' ? 'https://api.deepseek.com' : undefined}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </label>
          )}
          {apiPath === undefined ? null : (
            <label className="dsh-settings__provider-editor-field">
              <span>{t('settings.providerApi')}</span>
              {apiField?.enumValues === undefined || apiField.enumValues.length === 0 ? (
                <input
                  type="text"
                  value={api}
                  disabled={disabled}
                  onChange={(event) => setApi(event.target.value)}
                />
              ) : (
                <SelectMenu
                  className="dsh-settings__provider-api-select"
                  icon="settings"
                  menuMode="flow"
                  label={api === '' ? t('settings.notSet') : api}
                  ariaLabel={t('settings.providerApi')}
                  title={t('settings.providerApi')}
                  value={api}
                  options={apiOptions}
                  disabled={disabled}
                  onChange={setApi}
                />
              )}
            </label>
          )}
          {hasModelList ? (
            <details className="dsh-settings__provider-editor-customized" open>
              <summary>{t('settings.customized')}</summary>
              <ModelListEditor
                models={models}
                writable={props.writable}
                saving={props.saving}
                showSave={false}
                discoveryInput={discoveryInput}
                onDiscover={props.onDiscover}
                onChange={(next) => setModels(next.map(copyModel))}
                onSave={() => Promise.resolve()}
              />
            </details>
          ) : null}
        </>
      )}
      {error === undefined ? null : (
        <p className="dsh-settings__error" role="alert">
          {error}
        </p>
      )}
      <footer className="dsh-settings__provider-editor-actions">
        <button
          className="dsh-button dsh-button--secondary dsh-button--compact"
          type="button"
          disabled={props.saving}
          onClick={() => props.onClose(false)}
        >
          {t('settings.cancel')}
        </button>
        <button
          className="dsh-button dsh-button--primary dsh-button--compact"
          type="button"
          disabled={disabled || !supported}
          onClick={() => void save()}
        >
          {props.saving ? t('settings.applying') : t('settings.apply')}
        </button>
      </footer>
    </div>
  )
}

type CapacityField = 'contextWindow' | 'maxTokens'
type ModelFailure =
  | { readonly kind: 'id' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'capacity'; readonly field: CapacityField }

/**
 * The model list editor keeps unparsable capacity text in a per-row display
 * buffer next to the model state, so this form only sees an invalid number as
 * `NaN`. Rejecting it here keeps the value from crossing the transport, where
 * JSON serialization would turn it into `null` and store a corrupt capacity.
 */
function validateModels(models: readonly EditableModel[]): ModelFailure | undefined {
  const ids = new Set<string>()
  for (const model of models) {
    const id = model.id.trim()
    if (id === '') return { kind: 'id' }
    if (ids.has(id)) return { kind: 'duplicate' }
    ids.add(id)
    for (const field of ['contextWindow', 'maxTokens'] as const) {
      const value = model[field]
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
        return { kind: 'capacity', field }
    }
  }
  return undefined
}

function modelFailureMessage(failure: ModelFailure, t: Translate): string {
  if (failure.kind === 'id') return t('settings.modelIdRequired')
  if (failure.kind === 'duplicate') return t('settings.modelIdDuplicate')
  return t('settings.invalidCapacity', { field: t(`settings.${failure.field}`) })
}

function addOptionalChange(
  changes: ProviderSettingChange[],
  path: string | undefined,
  value: string,
  initial: string,
): void {
  if (path === undefined) return
  const next = value.trim()
  const previous = initial.trim()
  if (next === previous) return
  if (next === '') changes.push({ kind: 'unset', path })
  else changes.push({ kind: 'set', path, value: next })
}

function stringField(provider: ModelProvider, match: RegExp): ProviderFieldRef | undefined {
  const field = provider.fields.find((candidate) => !candidate.secret && match.test(candidate.key))
  if (field === undefined) return undefined
  return {
    key: field.key,
    value: field.value ?? '',
    ...(field.enumValues === undefined ? {} : { enumValues: field.enumValues }),
  }
}

function stringAt(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const next = (value as Record<string, unknown>)[key]
  return typeof next === 'string' ? next : undefined
}

function settingValueAt(values: Readonly<Record<string, unknown>>, path: readonly string[]): unknown {
  let current: unknown = values
  for (const part of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function modelListAt(value: unknown): EditableModel[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id.trim() === '') return []
    const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name : undefined
    const contextWindow = positiveNumber(record.contextWindow)
    const maxTokens = positiveNumber(record.maxTokens)
    const extra = Object.fromEntries(
      Object.entries(record).filter(([key]) => !['name', 'contextWindow', 'maxTokens'].includes(key)),
    )
    const model: EditableModel = {
      ...extra,
      id: record.id,
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }
    return [model]
  })
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function copyModel(model: EditableModel): EditableModel {
  // Keep fields introduced by a newer DSH schema (for example
  // `inputModalities: ['text', 'image']`) intact while this editor only
  // exposes the common id/name/capacity controls. Dropping them on a no-op
  // edit would make opening and applying the provider form destructive.
  return { ...model }
}
