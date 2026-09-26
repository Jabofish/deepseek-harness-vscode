import { useState, type ReactElement } from 'react'
import type {
  CustomProviderCreateResult,
  CustomProviderDraft,
  DiscoveredModel,
  ModelDiscoveryInput,
  ModelProvider,
} from '@dsh-vscode/domain'
import { isValidCustomProviderId } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'
import { useI18n } from '../../i18n.js'
import { SelectMenu } from '../../components/common/SelectMenu.js'
import { ModelListEditor, type EditableModel } from './ModelListEditor.js'

export interface CustomProviderTemplate {
  readonly settingsNamespace: string
  readonly collectionPath: readonly string[]
  /** Protocols read from the connected DSH Schemastery union. */
  readonly protocols: readonly string[]
  /** Namespace revision captured when this card was opened. */
  readonly revision: number
  readonly api?: string
}

export interface CustomProviderCardProps {
  readonly template: CustomProviderTemplate
  readonly providers: readonly ModelProvider[]
  readonly writable: boolean
  readonly saving: boolean
  readonly onClose: (changed: boolean) => void
  /** The Host collects the optional key and performs the two-stage create. */
  readonly onCreate: (draft: CustomProviderDraft) => Promise<CustomProviderCreateResult>
  /** Retry the credential stage without resending the already committed profile. */
  readonly onConfigureSecret: (providerId: string, field: string) => Promise<boolean>
  /** Custom discovery may prompt for an optional Host-only key. */
  readonly onDiscover: (input: Omit<ModelDiscoveryInput, 'apiKey'>) => Promise<readonly DiscoveredModel[]>
}

export function CustomProviderCard(props: CustomProviderCardProps): ReactElement {
  const { t } = useI18n()
  // The write is checked against the exact revision that was visible when the
  // card opened. A route added in another window must become a conflict.
  const [openedAt] = useState(() => props.template.revision)
  const [route, setRoute] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [api, setApi] = useState(props.template.api ?? props.template.protocols[0] ?? '')
  const [models, setModels] = useState<EditableModel[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [committed, setCommitted] = useState(false)

  const routeValue = route.trim()
  const displayNameValue = displayName.trim()
  const baseUrlValue = baseUrl.trim()
  const apiValue = api.trim()
  const routeInvalid = routeValue !== '' && !isValidCustomProviderId(routeValue)
  const routeTaken = props.providers.some((provider) => provider.id === routeValue)
  const modelFailure = validateModels(models)
  const normalizedModels = models.map(normalizeModel)
  const ready =
    props.template.protocols.length > 0 &&
    routeValue !== '' &&
    !routeInvalid &&
    !routeTaken &&
    baseUrlValue !== '' &&
    apiValue !== '' &&
    normalizedModels.length > 0 &&
    modelFailure === undefined
  const disabled = !props.writable || props.saving || busy
  const profileDisabled = disabled || committed
  const canSubmit = !disabled && (committed || ready)
  const apiOptions = [
    ...(api !== '' && !props.template.protocols.includes(api) ? [{ value: api, label: api }] : []),
    ...props.template.protocols.map((protocol) => ({ value: protocol, label: protocol })),
  ]

  const discoveryInput: Omit<ModelDiscoveryInput, 'apiKey'> = {
    settingsNamespace: props.template.settingsNamespace,
    ...(routeValue === '' ? {} : { providerId: routeValue }),
    ...(baseUrlValue === '' ? {} : { baseUrl: baseUrlValue }),
    ...(apiValue === '' ? {} : { api: apiValue }),
  }

  const save = async (): Promise<void> => {
    if (!canSubmit) return
    setBusy(true)
    setError(undefined)
    try {
      if (committed) {
        const configured = await props.onConfigureSecret(routeValue, 'apiKeyEnv')
        if (!configured) {
          setError(t('settings.providerCredentialCancelled'))
          return
        }
        props.onClose(true)
        return
      }

      const outcome = await props.onCreate({
        settingsNamespace: props.template.settingsNamespace,
        collectionPath: [...props.template.collectionPath],
        providerId: routeValue,
        ...(displayNameValue === '' ? {} : { displayName: displayNameValue }),
        api: apiValue,
        baseUrl: baseUrlValue,
        models: normalizedModels.map((model) => ({ ...model })),
        expectedRevision: openedAt,
      })
      if (!outcome.profileCommitted) {
        setError(t('settings.providerCreateIncomplete'))
        return
      }
      // Once the profile lands, retrying the entire operation would reuse the
      // superseded revision and can never repair a credential-only failure.
      setCommitted(true)
      if (outcome.credentialError !== undefined) {
        setError(outcome.credentialError)
        return
      }
      props.onClose(true)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="dsh-settings__custom-provider" aria-label={t('settings.customProvider')}>
      <div className="dsh-settings__custom-provider-head">
        <div>
          <strong>{t('settings.customProvider')}</strong>
          <p>{t('settings.customProviderNote')}</p>
          <p className="dsh-settings__advanced-hint">{t('settings.customProviderCredentialHint')}</p>
        </div>
        <button
          className="dsh-icon-button"
          type="button"
          aria-label={t('settings.closeEditor')}
          title={t('settings.closeEditor')}
          disabled={disabled}
          onClick={() => props.onClose(committed)}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="dsh-settings__custom-provider-grid">
        <label>
          <span>{t('settings.providerId')}</span>
          <input
            type="text"
            value={route}
            disabled={profileDisabled}
            onChange={(event) => {
              setError(undefined)
              setRoute(event.target.value)
            }}
          />
        </label>
        <label>
          <span>{t('settings.providerDisplayName')}</span>
          <input
            type="text"
            value={displayName}
            disabled={profileDisabled}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <label>
          <span>{t('settings.providerBaseUrl')}</span>
          <input
            type="url"
            value={baseUrl}
            disabled={profileDisabled}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label>
          <span>{t('settings.providerApi')}</span>
          <SelectMenu
            className="dsh-settings__provider-api-select"
            icon="settings"
            menuMode="flow"
            label={api === '' ? t('settings.notSet') : api}
            ariaLabel={t('settings.providerApi')}
            title={t('settings.providerApi')}
            value={api}
            options={apiOptions}
            disabled={profileDisabled}
            onChange={setApi}
          />
        </label>
      </div>
      {routeInvalid ? <p className="dsh-settings__error">{t('settings.providerRouteInvalid')}</p> : null}
      {routeTaken ? <p className="dsh-settings__error">{t('settings.providerRouteTaken')}</p> : null}
      {modelFailure?.kind === 'id' ? (
        <p className="dsh-settings__error">{t('settings.modelIdRequired')}</p>
      ) : null}
      {modelFailure?.kind === 'duplicate' ? (
        <p className="dsh-settings__error">{t('settings.modelIdDuplicate')}</p>
      ) : null}
      {modelFailure?.kind === 'capacity' ? (
        <p className="dsh-settings__error">
          {t('settings.invalidCapacity', { field: t(`settings.${modelFailure.field}`) })}
        </p>
      ) : null}
      {modelFailure?.kind === 'input' ? (
        <p className="dsh-settings__error">{t('settings.modelInputRequired')}</p>
      ) : null}
      <ModelListEditor
        models={models}
        inputField="input"
        writable={props.writable && !committed}
        saving={props.saving || busy}
        showSave={false}
        discoveryInput={discoveryInput}
        onDiscover={props.onDiscover}
        onChange={(next) => setModels(next.map((model) => ({ ...model })))}
        onSave={(next) => {
          setModels(next.map((model) => ({ ...model })))
          return Promise.resolve()
        }}
      />
      {error === undefined ? null : (
        <p className="dsh-settings__error" role="alert">
          {error}
        </p>
      )}
      <button
        className="dsh-button dsh-button--primary dsh-button--compact"
        type="button"
        disabled={!canSubmit}
        onClick={() => void save()}
      >
        {committed ? t('settings.retryProviderCredential') : t('settings.saveProvider')}
      </button>
    </section>
  )
}

type ModelFailure =
  | { readonly kind: 'id' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'capacity'; readonly field: 'contextWindow' | 'maxTokens' }
  | { readonly kind: 'input' }
  | undefined

function validateModels(models: readonly EditableModel[]): ModelFailure {
  const ids = new Set<string>()
  for (const model of models) {
    const id = model.id.trim()
    if (id === '' || id.length > 256) return { kind: 'id' }
    if (ids.has(id)) return { kind: 'duplicate' }
    ids.add(id)
    const input = model.input
    if (
      input !== undefined &&
      (!Array.isArray(input) || input.some((value) => value !== 'text' && value !== 'image'))
    )
      return { kind: 'input' }
    for (const field of ['contextWindow', 'maxTokens'] as const) {
      const value = model[field]
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
        return { kind: 'capacity', field }
    }
  }
  return undefined
}

function normalizeModel(model: EditableModel): EditableModel {
  const { name, ...rest } = model
  return {
    ...rest,
    id: model.id.trim(),
    ...(name === undefined || name.trim() === '' ? {} : { name: name.trim() }),
  }
}
