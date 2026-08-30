import { useMemo, useState, type ReactElement } from 'react'
import type { DshSettingsSnapshot } from '../../app/store.js'
import { useI18n } from '../../i18n.js'

export interface PluginConfigurationProps {
  readonly snapshot: DshSettingsSnapshot | undefined
  readonly onReload: () => Promise<DshSettingsSnapshot | undefined>
  readonly onUpdateSetting: (path: string, value: unknown) => Promise<void>
  readonly onUnsetSetting: (path: string) => Promise<void>
  /** The Extension Host opens the secret prompt; the Webview receives no key. */
  readonly onConfigureCredential?: ((ref: string) => Promise<boolean>) | undefined
  readonly onRemoveCredential?: ((ref: string) => Promise<void>) | undefined
}

type PluginFieldType = 'number' | 'text'

interface PluginFieldDefinition {
  readonly field: string
  readonly type: PluginFieldType
  readonly labelKey: string
  readonly hintKey: string
}

interface PluginDefinition {
  readonly namespace: string
  readonly titleKey: string
  readonly descriptionKey: string
  readonly fields: readonly PluginFieldDefinition[]
  readonly credential?: { readonly field: string; readonly fallbackRef: string }
}

interface Draft {
  readonly text: string
  readonly clear: boolean
}

const PLUGINS: readonly PluginDefinition[] = [
  {
    namespace: 'shell',
    titleKey: 'plugins.config.shell.title',
    descriptionKey: 'plugins.config.shell.description',
    fields: [
      {
        field: 'timeoutMs',
        type: 'number',
        labelKey: 'plugins.config.shell.timeoutMs',
        hintKey: 'plugins.config.shell.timeoutMsHint',
      },
      {
        field: 'maxOutputBytes',
        type: 'number',
        labelKey: 'plugins.config.shell.maxOutputBytes',
        hintKey: 'plugins.config.shell.maxOutputBytesHint',
      },
    ],
  },
  {
    namespace: 'agent-loop',
    titleKey: 'plugins.config.agentLoop.title',
    descriptionKey: 'plugins.config.agentLoop.description',
    fields: [
      {
        field: 'maxParallelToolCalls',
        type: 'number',
        labelKey: 'plugins.config.agentLoop.maxParallel',
        hintKey: 'plugins.config.agentLoop.maxParallelHint',
      },
    ],
  },
  {
    namespace: 'web-search-deepseek',
    titleKey: 'plugins.config.webSearch.title',
    descriptionKey: 'plugins.config.webSearch.description',
    fields: [
      {
        field: 'baseURL',
        type: 'text',
        labelKey: 'plugins.config.webSearch.baseUrl',
        hintKey: 'plugins.config.webSearch.baseUrlHint',
      },
      {
        field: 'maxUses',
        type: 'number',
        labelKey: 'plugins.config.webSearch.maxUses',
        hintKey: 'plugins.config.webSearch.maxUsesHint',
      },
    ],
    credential: { field: 'apiKey', fallbackRef: 'DEEPSEEK_API_KEY' },
  },
]

export function PluginConfiguration(props: PluginConfigurationProps): ReactElement {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({})
  const [saving, setSaving] = useState<string | undefined>()
  const [credentialBusy, setCredentialBusy] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const snapshot = props.snapshot

  const cards = useMemo(() => (snapshot === undefined ? [] : availablePlugins(snapshot)), [snapshot])

  const toggle = (namespace: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(namespace)) next.delete(namespace)
      else next.add(namespace)
      return next
    })
  }

  const draftKey = (namespace: string, field: string): string => `${namespace}.${field}`
  const stage = (namespace: string, field: string, text: string, clear = false): void => {
    setDrafts((current) => ({ ...current, [draftKey(namespace, field)]: { text, clear } }))
    setError(undefined)
  }

  const discard = (namespace: string): void => {
    setDrafts((current) => withoutNamespace(current, namespace))
    setError(undefined)
  }

  const save = async (plugin: AvailablePlugin): Promise<void> => {
    if (saving !== undefined || snapshot === undefined) return
    const pending = plugin.fields.flatMap((field) => {
      const key = draftKey(plugin.definition.namespace, field.field)
      const draft = drafts[key]
      return draft === undefined ? [] : [{ field, draft }]
    })
    if (pending.length === 0) return
    const invalid = pending.find(
      ({ field, draft }) =>
        field.type === 'number' && !draft.clear && draft.text.trim() !== '' && !isFiniteNumber(draft.text),
    )
    if (invalid !== undefined) {
      setError(t('plugins.config.invalidNumber'))
      return
    }
    setSaving(plugin.definition.namespace)
    setError(undefined)
    try {
      for (const { field, draft } of pending) {
        const path = `${plugin.definition.namespace}.${field.field}`
        if (draft.clear || draft.text.trim() === '') {
          await props.onUnsetSetting(path)
        } else {
          await props.onUpdateSetting(path, field.type === 'number' ? Number(draft.text) : draft.text.trim())
        }
      }
      const next = await props.onReload()
      if (next === undefined) throw new Error(t('plugins.config.saveFailed'))
      setDrafts((current) => withoutNamespace(current, plugin.definition.namespace))
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t('plugins.config.saveFailed'))
    } finally {
      setSaving(undefined)
    }
  }

  const configureCredential = async (plugin: AvailablePlugin): Promise<void> => {
    const credential = plugin.credential
    if (credential === undefined || props.onConfigureCredential === undefined || credentialBusy !== undefined)
      return
    setCredentialBusy(plugin.definition.namespace)
    setError(undefined)
    try {
      const configured = await props.onConfigureCredential(credential.ref)
      if (configured) await props.onReload()
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t('plugins.config.credentialFailed'))
    } finally {
      setCredentialBusy(undefined)
    }
  }

  const removeCredential = async (plugin: AvailablePlugin): Promise<void> => {
    const credential = plugin.credential
    if (credential === undefined || props.onRemoveCredential === undefined || credentialBusy !== undefined)
      return
    setCredentialBusy(plugin.definition.namespace)
    setError(undefined)
    try {
      await props.onRemoveCredential(credential.ref)
      await props.onReload()
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t('plugins.config.credentialFailed'))
    } finally {
      setCredentialBusy(undefined)
    }
  }

  if (snapshot === undefined) {
    return <p className="dsh-settings__empty">{t('plugins.config.unavailable')}</p>
  }

  return (
    <section className="dsh-plugin-configuration" aria-label={t('plugins.config.heading')}>
      <div className="dsh-plugin-configuration__intro">
        <h3>{t('plugins.config.heading')}</h3>
        <p>{t('plugins.config.intro')}</p>
      </div>
      {cards.length === 0 ? (
        <p className="dsh-settings__empty">{t('plugins.config.empty')}</p>
      ) : (
        <ul className="dsh-plugin-configuration__cards">
          {cards.map((plugin) => {
            const namespace = plugin.definition.namespace
            const open = expanded.has(namespace)
            const dirty = plugin.fields.some(
              (field) => drafts[draftKey(namespace, field.field)] !== undefined,
            )
            const invalid = plugin.fields.some((field) => {
              const draft = drafts[draftKey(namespace, field.field)]
              return (
                draft !== undefined &&
                field.type === 'number' &&
                !draft.clear &&
                draft.text.trim() !== '' &&
                !isFiniteNumber(draft.text)
              )
            })
            const busy = saving === namespace || credentialBusy === namespace
            const detailsId = `dsh-plugin-config-${namespace.replace(/[^a-z0-9]+/giu, '-')}`
            return (
              <li className="dsh-plugin-configuration__card" key={namespace} data-plugin-config={namespace}>
                <button
                  type="button"
                  className="dsh-plugin-configuration__header"
                  aria-expanded={open}
                  aria-controls={detailsId}
                  onClick={() => toggle(namespace)}
                >
                  <span className="dsh-plugin-configuration__header-copy">
                    <span className="dsh-plugin-configuration__title-line">
                      <span
                        className={`dsh-plugin-status-dot dsh-plugin-status-dot--${
                          plugin.credential === undefined
                            ? 'available'
                            : plugin.credential.configured
                              ? 'configured'
                              : 'missing'
                        }`}
                        data-state={
                          plugin.credential === undefined
                            ? 'available'
                            : plugin.credential.configured
                              ? 'configured'
                              : 'missing'
                        }
                        aria-hidden="true"
                      />
                      <strong>{t(plugin.definition.titleKey)}</strong>
                    </span>
                    <span>{t(plugin.definition.descriptionKey)}</span>
                  </span>
                  {dirty ? (
                    <span className="dsh-plugin-configuration__unsaved">{t('plugins.config.unsaved')}</span>
                  ) : null}
                  <span
                    className={`dsh-plugin-configuration__chevron${open ? ' dsh-plugin-configuration__chevron--open' : ''}`}
                    aria-hidden="true"
                  >
                    ⌄
                  </span>
                </button>
                {open ? (
                  <div className="dsh-plugin-configuration__body" id={detailsId}>
                    {!snapshot.schema.writable ? (
                      <p className="dsh-plugin-configuration__readonly" role="status">
                        {t('plugins.config.readOnly')}
                      </p>
                    ) : null}
                    {plugin.fields.map((field) => {
                      const key = draftKey(namespace, field.field)
                      const draft = drafts[key]
                      const text =
                        draft === undefined ? fieldValue(snapshot, namespace, field.field) : draft.text
                      const overridden = isUserField(snapshot, namespace, field.field)
                      const fieldInvalid =
                        draft !== undefined &&
                        field.type === 'number' &&
                        !draft.clear &&
                        draft.text.trim() !== '' &&
                        !isFiniteNumber(draft.text)
                      const inputId = `dsh-plugin-config-field-${namespace.replace(/[^a-z0-9]+/giu, '-')}-${field.field}`
                      return (
                        <label
                          className="dsh-plugin-configuration__field"
                          htmlFor={inputId}
                          key={field.field}
                        >
                          <span className="dsh-plugin-configuration__field-head">
                            <span>{t(field.labelKey)}</span>
                            {overridden ? <small>{t('plugins.config.overridden')}</small> : null}
                          </span>
                          <input
                            id={inputId}
                            type="text"
                            inputMode={field.type === 'number' ? 'numeric' : undefined}
                            value={text}
                            disabled={!snapshot.schema.writable || busy}
                            aria-invalid={fieldInvalid}
                            onChange={(event) => stage(namespace, field.field, event.currentTarget.value)}
                          />
                          <span
                            className={
                              fieldInvalid
                                ? 'dsh-plugin-configuration__hint dsh-plugin-configuration__hint--error'
                                : 'dsh-plugin-configuration__hint'
                            }
                          >
                            {fieldInvalid ? t('plugins.config.invalidNumber') : t(field.hintKey)}
                          </span>
                          {overridden ? (
                            <button
                              type="button"
                              className="dsh-plugin-configuration__reset"
                              disabled={!snapshot.schema.writable || busy}
                              onClick={() => stage(namespace, field.field, '', true)}
                            >
                              {t('plugins.config.reset')}
                            </button>
                          ) : null}
                        </label>
                      )
                    })}
                    {plugin.credential === undefined ? null : (
                      <div className="dsh-plugin-configuration__credential">
                        <div className="dsh-plugin-configuration__field-head">
                          <span>{t('plugins.config.webSearch.apiKey')}</span>
                          <small>
                            {plugin.credential.configured
                              ? t('plugins.config.credentialConfigured')
                              : t('plugins.config.credentialMissing')}
                          </small>
                        </div>
                        <span className="dsh-plugin-configuration__hint">
                          {t('plugins.config.webSearch.apiKeyHint')}
                        </span>
                        {props.onConfigureCredential === undefined ? null : (
                          <div className="dsh-plugin-configuration__credential-actions">
                            <button
                              type="button"
                              className="dsh-button dsh-button--secondary dsh-button--compact"
                              disabled={busy}
                              onClick={() => void configureCredential(plugin)}
                            >
                              {plugin.credential.configured
                                ? t('plugins.config.credentialReplace')
                                : t('plugins.config.credentialConfigure')}
                            </button>
                            {plugin.credential.configured && props.onRemoveCredential !== undefined ? (
                              <button
                                type="button"
                                className="dsh-button dsh-button--danger dsh-button--compact"
                                disabled={busy}
                                onClick={() => void removeCredential(plugin)}
                              >
                                {t('plugins.config.credentialRemove')}
                              </button>
                            ) : null}
                          </div>
                        )}
                      </div>
                    )}
                    <div className="dsh-plugin-configuration__footer">
                      {error !== undefined ? (
                        <p className="dsh-plugin-configuration__error" role="alert">
                          {error}
                        </p>
                      ) : null}
                      <button
                        type="button"
                        className="dsh-button dsh-button--secondary dsh-button--compact"
                        disabled={!dirty || busy}
                        onClick={() => discard(namespace)}
                      >
                        {t('plugins.config.discard')}
                      </button>
                      <button
                        type="button"
                        className="dsh-button dsh-button--primary dsh-button--compact"
                        disabled={!dirty || invalid || busy || !snapshot.schema.writable}
                        onClick={() => void save(plugin)}
                      >
                        {saving === namespace ? t('plugins.config.saving') : t('plugins.config.save')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

interface AvailablePlugin {
  readonly definition: PluginDefinition
  readonly fields: readonly PluginFieldDefinition[]
  readonly credential?: { readonly ref: string; readonly configured: boolean }
}

function availablePlugins(snapshot: DshSettingsSnapshot): readonly AvailablePlugin[] {
  return PLUGINS.flatMap((definition) => {
    if (!snapshot.schema.namespaces.some((namespace) => namespace.ns === definition.namespace)) return []
    const fields = definition.fields.filter((field) =>
      snapshot.schema.fields.some((candidate) => candidate.path === `${definition.namespace}.${field.field}`),
    )
    const credential = definition.credential
    const namespaceValue = settingValueAt(snapshot.values, definition.namespace)
    const secret =
      credential === undefined
        ? undefined
        : snapshot.schema.namespaces
            .find((namespace) => namespace.ns === definition.namespace)
            ?.secrets.find((item) => item.field === credential.field)
    if (fields.length === 0 && secret === undefined) return []
    const availableCredential =
      credential === undefined || secret === undefined
        ? undefined
        : {
            ref: settingString(namespaceValue, 'apiKeyEnv') ?? credential.fallbackRef,
            configured: secret.set,
          }
    return [
      {
        definition,
        fields,
        ...(availableCredential === undefined ? {} : { credential: availableCredential }),
      },
    ]
  })
}

function fieldValue(snapshot: DshSettingsSnapshot, namespace: string, field: string): string {
  const value = settingValueAt(snapshot.values, `${namespace}.${field}`)
  return typeof value === 'number' || typeof value === 'string' ? String(value) : ''
}

function isUserField(snapshot: DshSettingsSnapshot, namespace: string, field: string): boolean {
  return snapshot.schema.namespaces.find((item) => item.ns === namespace)?.userFields.includes(field) === true
}

function settingValueAt(values: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = values
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function settingString(value: unknown, field: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = (value as Record<string, unknown>)[field]
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate : undefined
}

function isFiniteNumber(value: string): boolean {
  return Number.isFinite(Number(value.trim()))
}

function withoutNamespace(
  drafts: Readonly<Record<string, Draft>>,
  namespace: string,
): Readonly<Record<string, Draft>> {
  return Object.fromEntries(Object.entries(drafts).filter(([key]) => !key.startsWith(`${namespace}.`)))
}
