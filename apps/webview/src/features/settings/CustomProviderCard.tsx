import { useState, type ReactElement } from 'react'
import type { DiscoveredModel, ModelDiscoveryInput, ModelProvider } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'
import { useI18n } from '../../i18n.js'
import { ModelListEditor, type EditableModel } from './ModelListEditor.js'

export interface CustomProviderTemplate {
  readonly settingsNamespace: string
  readonly collectionPath: readonly string[]
  readonly api?: string
}

export interface CustomProviderCardProps {
  readonly template: CustomProviderTemplate
  readonly providers: readonly ModelProvider[]
  readonly writable: boolean
  readonly saving: boolean
  readonly onSave: (path: string, value: Readonly<Record<string, unknown>>) => Promise<void>
  readonly onDiscover: (input: Omit<ModelDiscoveryInput, 'apiKey'>) => Promise<readonly DiscoveredModel[]>
}

const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

export function CustomProviderCard(props: CustomProviderCardProps): ReactElement {
  const { t } = useI18n()
  const [route, setRoute] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [api, setApi] = useState(props.template.api ?? '')
  const [models, setModels] = useState<EditableModel[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)

  const routeInvalid = route.trim() !== '' && !ROUTE_PATTERN.test(route.trim())
  const routeTaken = props.providers.some((provider) => provider.id === route.trim())
  const canSave =
    props.writable &&
    !props.saving &&
    !saved &&
    route.trim() !== '' &&
    !routeInvalid &&
    !routeTaken &&
    baseUrl.trim() !== '' &&
    api.trim() !== '' &&
    models.length > 0 &&
    models.every((model) => model.id.trim() !== '')

  const save = async (): Promise<void> => {
    if (!canSave) return
    setError(undefined)
    try {
      const path = [...props.template.collectionPath, route.trim()].join('.')
      await props.onSave(`${props.template.settingsNamespace}.${path}`, {
        ...(displayName.trim() === '' ? {} : { displayName: displayName.trim() }),
        api,
        baseURL: baseUrl.trim(),
        models: models.map((model) => ({ ...model, id: model.id.trim() })),
      })
      setSaved(true)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
    }
  }

  const discoveryInput: Omit<ModelDiscoveryInput, 'apiKey'> = {
    settingsNamespace: props.template.settingsNamespace,
    ...(route.trim() === '' ? {} : { providerId: route.trim() }),
    ...(baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
    ...(api.trim() === '' ? {} : { api: api.trim() }),
  }

  return (
    <section className="dsh-settings__custom-provider" aria-label={t('settings.customProvider')}>
      <div className="dsh-settings__custom-provider-head">
        <div>
          <strong>{t('settings.customProvider')}</strong>
          <p>{t('settings.customProviderNote')}</p>
        </div>
        <Icon name="add" />
      </div>
      <div className="dsh-settings__custom-provider-grid">
        <label>
          <span>{t('settings.providerId')}</span>
          <input
            type="text"
            value={route}
            disabled={!props.writable || props.saving || saved}
            onChange={(event) => {
              setSaved(false)
              setRoute(event.target.value)
            }}
          />
        </label>
        <label>
          <span>{t('settings.providerDisplayName')}</span>
          <input
            type="text"
            value={displayName}
            disabled={!props.writable || props.saving || saved}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <label>
          <span>{t('settings.providerBaseUrl')}</span>
          <input
            type="url"
            value={baseUrl}
            disabled={!props.writable || props.saving || saved}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label>
          <span>{t('settings.providerApi')}</span>
          <input
            type="text"
            value={api}
            disabled={!props.writable || props.saving || saved}
            onChange={(event) => setApi(event.target.value)}
          />
        </label>
      </div>
      {routeInvalid ? <p className="dsh-settings__error">{t('settings.providerRouteInvalid')}</p> : null}
      {routeTaken ? <p className="dsh-settings__error">{t('settings.providerRouteTaken')}</p> : null}
      <ModelListEditor
        models={models}
        writable={props.writable && !saved}
        saving={props.saving}
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
      {saved ? (
        <p className="dsh-settings__saved" role="status">
          {t('settings.providerSaved')}
        </p>
      ) : null}
      <button
        className="dsh-button dsh-button--primary dsh-button--compact"
        type="button"
        disabled={!canSave}
        onClick={() => void save()}
      >
        {t('settings.saveProvider')}
      </button>
    </section>
  )
}
