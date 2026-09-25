import { useId, useMemo, useState, type ReactElement } from 'react'
import type { DshSettingsSnapshot } from '../../app/store.js'
import { ContentFlow } from '../../components/common/ContentFlow.js'
import { SelectMenu, type SelectMenuOption } from '../../components/common/SelectMenu.js'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface PluginConfigurationProps {
  readonly snapshot: DshSettingsSnapshot | undefined
  readonly onReload: () => Promise<DshSettingsSnapshot | undefined>
  readonly onUpdateSetting: (path: string, value: unknown) => Promise<void>
  readonly onUnsetSetting: (path: string) => Promise<void>
  /** The Extension Host opens the secret prompt; the Webview receives no key. */
  readonly onConfigureCredential?: ((ref: string) => Promise<boolean>) | undefined
  readonly onRemoveCredential?: ((ref: string) => Promise<void>) | undefined
}

/**
 * The pinned `settings.describe` answer names the writable field types. Text,
 * number, truth values, and fixed choice lists all round-trip through a single
 * control; secrets are listed separately because they are written through the
 * credential surface, never as a value.
 */
type PluginFieldKind = 'text' | 'number' | 'boolean' | 'enum' | 'object' | 'array'

interface PluginField {
  readonly field: string
  readonly path: string
  readonly kind: PluginFieldKind
  readonly label: string
  readonly description: string | undefined
  /** Choice list for `boolean` and `enum`; text and number render an input. */
  readonly options?: readonly string[]
  readonly overridden: boolean
}

interface PluginCredential {
  readonly field: string
  readonly label: string
  /** Reference the host stores the secret under, as the namespace states it. */
  readonly reference: string
  readonly configured: boolean
}

interface Plugin {
  readonly namespace: string
  readonly applies: 'live' | 'restart'
  readonly revision: number
  readonly fields: readonly PluginField[]
  readonly credentials: readonly PluginCredential[]
}

interface Draft {
  readonly text: string
  readonly clear: boolean
}

export function PluginConfiguration(props: PluginConfigurationProps): ReactElement {
  const { t } = useI18n()
  const [sectionOpen, setSectionOpen] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({})
  const [saving, setSaving] = useState<string | undefined>()
  const [credentialBusy, setCredentialBusy] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const snapshot = props.snapshot
  const sectionBodyId = useId()

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

  const save = async (plugin: Plugin): Promise<void> => {
    if (saving !== undefined || snapshot === undefined) return
    const pending = plugin.fields.flatMap((field) => {
      const key = draftKey(plugin.namespace, field.field)
      const draft = drafts[key]
      return draft === undefined ? [] : [{ field, draft }]
    })
    if (pending.length === 0) return
    const invalid = pending.find(({ field, draft }) => invalidDraft(field.kind, draft))
    if (invalid !== undefined) {
      setError(
        t(invalid.field.kind === 'number' ? 'plugins.config.invalidNumber' : 'plugins.config.invalidJson'),
      )
      return
    }
    setSaving(plugin.namespace)
    setError(undefined)
    try {
      for (const { field, draft } of pending) {
        if (draft.clear || (field.kind !== 'text' && field.kind !== 'enum' && draft.text.trim() === '')) {
          await props.onUnsetSetting(field.path)
        } else {
          await props.onUpdateSetting(field.path, fieldValueFor(field.kind, draft.text))
        }
      }
      const next = await props.onReload()
      if (next === undefined) throw new Error(t('plugins.config.saveFailed'))
      setDrafts((current) => withoutNamespace(current, plugin.namespace))
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t('plugins.config.saveFailed'))
    } finally {
      setSaving(undefined)
    }
  }

  const configureCredential = async (plugin: Plugin, credential: PluginCredential): Promise<void> => {
    if (props.onConfigureCredential === undefined || credentialBusy !== undefined) return
    setCredentialBusy(`${plugin.namespace}.${credential.field}`)
    setError(undefined)
    try {
      const configured = await props.onConfigureCredential(credential.reference)
      if (configured) await props.onReload()
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t('plugins.config.credentialFailed'))
    } finally {
      setCredentialBusy(undefined)
    }
  }

  const removeCredential = async (plugin: Plugin, credential: PluginCredential): Promise<void> => {
    if (props.onRemoveCredential === undefined || credentialBusy !== undefined) return
    setCredentialBusy(`${plugin.namespace}.${credential.field}`)
    setError(undefined)
    try {
      await props.onRemoveCredential(credential.reference)
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
      <div className="dsh-plugin-configuration__heading">
        <h3 className="dsh-plugin-configuration__section-title">
          <button
            type="button"
            className="dsh-plugin-configuration__section-toggle"
            aria-expanded={sectionOpen}
            aria-controls={sectionOpen ? sectionBodyId : undefined}
            onClick={() => setSectionOpen((current) => !current)}
          >
            <Icon name={sectionOpen ? 'chevron-down' : 'chevron-right'} />
            <span>{t('plugins.config.heading')}</span>
          </button>
        </h3>
        <span className="dsh-plugin-configuration__section-count" data-plugin-count={cards.length}>
          {t('plugins.inventory.totalCount', { count: cards.length })}
        </span>
      </div>
      {sectionOpen ? (
        <div className="dsh-plugin-configuration__section-body" id={sectionBodyId}>
          <ContentFlow as="p" className="dsh-plugin-configuration__intro">
            {t('plugins.config.intro')}
          </ContentFlow>
          {cards.length === 0 ? (
            <p className="dsh-settings__empty">{t('plugins.config.empty')}</p>
          ) : (
            <ul className="dsh-plugin-configuration__cards">
              {cards.map((plugin) => {
                const namespace = plugin.namespace
                const open = expanded.has(namespace)
                const dirty = plugin.fields.some(
                  (field) => drafts[draftKey(namespace, field.field)] !== undefined,
                )
                const invalid = plugin.fields.some((field) => {
                  const draft = drafts[draftKey(namespace, field.field)]
                  return draft !== undefined && invalidDraft(field.kind, draft)
                })
                const busy = saving === namespace || credentialBusy?.startsWith(`${namespace}.`) === true
                const detailsId = `dsh-plugin-config-${namespace.replace(/[^a-z0-9]+/giu, '-')}`
                const credentialTone =
                  plugin.credentials.length === 0
                    ? 'available'
                    : plugin.credentials.every((credential) => credential.configured)
                      ? 'configured'
                      : 'missing'
                return (
                  <li
                    className="dsh-plugin-configuration__card"
                    key={namespace}
                    data-plugin-config={namespace}
                  >
                    <button
                      type="button"
                      className="dsh-plugin-configuration__header"
                      aria-expanded={open}
                      aria-controls={detailsId}
                      onClick={() => toggle(namespace)}
                    >
                      <span className="dsh-plugin-configuration__title-line">
                        <span
                          className={`dsh-plugin-status-dot dsh-plugin-status-dot--${credentialTone}`}
                          data-state={credentialTone}
                          aria-hidden="true"
                        />
                        <strong title={namespace}>{namespace}</strong>
                        {plugin.applies === 'restart' ? (
                          <span className="dsh-plugin-configuration__applies">
                            {t('plugins.config.applies.restart')}
                          </span>
                        ) : null}
                      </span>
                      {dirty ? (
                        <span className="dsh-plugin-configuration__unsaved">
                          {t('plugins.config.unsaved')}
                        </span>
                      ) : null}
                      <span
                        className={`dsh-plugin-configuration__chevron${open ? ' dsh-plugin-configuration__chevron--open' : ''}`}
                        aria-hidden="true"
                      >
                        <Icon name="chevron-down" />
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
                          const text = draft === undefined ? fieldValue(snapshot, field.path) : draft.text
                          const fieldInvalid = draft !== undefined && invalidDraft(field.kind, draft)
                          const inputId = `dsh-plugin-config-field-${namespace.replace(/[^a-z0-9]+/giu, '-')}-${field.field}`
                          const choiceKnown =
                            field.options !== undefined &&
                            draft?.clear !== true &&
                            field.options.includes(text)
                          const choiceOptions: readonly SelectMenuOption[] = [
                            { value: '', label: t('plugins.config.chooseValue') },
                            ...(field.options ?? []).map((option) => ({
                              value: JSON.stringify(option),
                              label: option,
                            })),
                          ]
                          return (
                            <label
                              className="dsh-plugin-configuration__field"
                              htmlFor={inputId}
                              key={field.field}
                            >
                              <span className="dsh-plugin-configuration__field-head">
                                <span>{field.label}</span>
                                {field.overridden ? <small>{t('plugins.config.overridden')}</small> : null}
                              </span>
                              {field.kind === 'object' || field.kind === 'array' ? (
                                <textarea
                                  id={inputId}
                                  rows={6}
                                  value={text}
                                  disabled={!snapshot.schema.writable || busy}
                                  aria-invalid={fieldInvalid}
                                  onChange={(event) =>
                                    stage(namespace, field.field, event.currentTarget.value)
                                  }
                                />
                              ) : field.options === undefined ? (
                                <input
                                  id={inputId}
                                  type="text"
                                  inputMode={field.kind === 'number' ? 'numeric' : undefined}
                                  value={text}
                                  disabled={!snapshot.schema.writable || busy}
                                  aria-invalid={fieldInvalid}
                                  onChange={(event) =>
                                    stage(namespace, field.field, event.currentTarget.value)
                                  }
                                />
                              ) : (
                                <SelectMenu
                                  id={inputId}
                                  className="dsh-plugin-configuration__choice"
                                  icon="list"
                                  density="regular"
                                  label={choiceKnown ? text : t('plugins.config.chooseValue')}
                                  ariaLabel={field.label}
                                  title={field.label}
                                  value={choiceKnown ? JSON.stringify(text) : ''}
                                  options={choiceOptions}
                                  disabled={!snapshot.schema.writable || busy}
                                  onChange={(value) => {
                                    if (value === '') stage(namespace, field.field, '', true)
                                    else stage(namespace, field.field, JSON.parse(value) as string)
                                  }}
                                />
                              )}
                              <ContentFlow
                                as="span"
                                className={
                                  fieldInvalid
                                    ? 'dsh-plugin-configuration__hint dsh-plugin-configuration__hint--error'
                                    : 'dsh-plugin-configuration__hint'
                                }
                              >
                                {fieldInvalid
                                  ? t(
                                      field.kind === 'number'
                                        ? 'plugins.config.invalidNumber'
                                        : 'plugins.config.invalidJson',
                                    )
                                  : (field.description ?? field.path)}
                              </ContentFlow>
                              {field.overridden ? (
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
                        {plugin.credentials.map((credential) => (
                          <div className="dsh-plugin-configuration__credential" key={credential.field}>
                            <div className="dsh-plugin-configuration__field-head">
                              <span>{credential.label}</span>
                              <small>
                                {credential.configured
                                  ? t('plugins.config.credentialConfigured')
                                  : t('plugins.config.credentialMissing')}
                              </small>
                            </div>
                            <span className="dsh-plugin-configuration__hint">
                              {t('plugins.config.credentialHint', { reference: credential.reference })}
                            </span>
                            {props.onConfigureCredential === undefined ? null : (
                              <div className="dsh-plugin-configuration__credential-actions">
                                <button
                                  type="button"
                                  className="dsh-button dsh-button--secondary dsh-button--compact"
                                  disabled={busy}
                                  onClick={() => void configureCredential(plugin, credential)}
                                >
                                  {credential.configured
                                    ? t('plugins.config.credentialReplace')
                                    : t('plugins.config.credentialConfigure')}
                                </button>
                                {credential.configured && props.onRemoveCredential !== undefined ? (
                                  <button
                                    type="button"
                                    className="dsh-button dsh-button--danger dsh-button--compact"
                                    disabled={busy}
                                    onClick={() => void removeCredential(plugin, credential)}
                                  >
                                    {t('plugins.config.credentialRemove')}
                                  </button>
                                ) : null}
                              </div>
                            )}
                          </div>
                        ))}
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
        </div>
      ) : null}
    </section>
  )
}

/**
 * Every card is derived from the host's own `settings.describe` answer: the
 * extension ships no plugin list, so a namespace DSH adds or removes appears
 * and disappears with the host instead of with a release of this extension.
 * Namespaces the descriptor exposes nothing writable for are not cards.
 */
function availablePlugins(snapshot: DshSettingsSnapshot): readonly Plugin[] {
  return snapshot.schema.namespaces.flatMap((namespace) => {
    const prefix = `${namespace.ns}.`
    const values = settingValueAt(snapshot.values, namespace.ns)
    const fields = snapshot.schema.fields.flatMap((field) => {
      if (!field.path.startsWith(prefix) || field.path === prefix) return []
      const name = field.path.slice(prefix.length)
      // Never replace a redacted container: doing so could erase or overwrite
      // credentials which are intentionally absent from the public snapshot.
      if (
        namespace.secrets.some(
          (secret) =>
            secret.field === name ||
            secret.field.startsWith(`${name}.`) ||
            name.startsWith(`${secret.field}.`),
        )
      )
        return []
      const kind = fieldKind(field.type, field.enumValues)
      if (kind === undefined) return []
      return [
        {
          field: name,
          path: field.path,
          kind,
          label: field.label.trim() === '' ? name : field.label,
          description: field.description,
          ...(kind === 'boolean'
            ? { options: ['true', 'false'] as const }
            : kind === 'enum'
              ? { options: field.enumValues ?? [] }
              : {}),
          overridden: namespace.userFields.includes(name),
        },
      ]
    })
    const credentials = namespace.secrets.flatMap((secret) => {
      // A secret is stored under the reference the namespace itself names —
      // DSH keeps that name in a sibling `<field>Env` setting. Without a
      // stated reference there is nothing to write, and guessing a name would
      // store the secret under a reference no plugin reads.
      const reference = credentialReference(values, secret.field)
      if (reference === undefined) return []
      const label = snapshot.schema.fields.find((field) => field.path === `${prefix}${secret.field}`)?.label
      return [
        {
          field: secret.field,
          label: label === undefined || label.trim() === '' ? secret.field : label,
          reference,
          configured: secret.set,
        },
      ]
    })
    if (fields.length === 0 && credentials.length === 0) return []
    return [
      {
        namespace: namespace.ns,
        applies: namespace.applies,
        revision: namespace.revision,
        fields,
        credentials,
      },
    ]
  })
}

function fieldKind(
  type: DshSettingsSnapshot['schema']['fields'][number]['type'],
  enumValues: readonly string[] | undefined,
): PluginFieldKind | undefined {
  switch (type) {
    case 'string':
      return 'text'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'enum':
      return enumValues === undefined || enumValues.length === 0 ? undefined : 'enum'
    case 'object':
    case 'array':
      return type
    // Secrets are written through the credential surface.
    case 'secret':
      return undefined
  }
}

function fieldValueFor(kind: PluginFieldKind, text: string): unknown {
  switch (kind) {
    case 'object':
    case 'array':
      return JSON.parse(text) as unknown
    case 'number':
      return Number(text.trim())
    case 'boolean':
      return text.trim() === 'true'
    case 'enum':
    case 'text':
      return text
  }
}

function credentialReference(value: unknown, field: string): string | undefined {
  return settingString(value, `${field}Env`) ?? settingString(value, 'apiKeyEnv')
}

function fieldValue(snapshot: DshSettingsSnapshot, path: string): string {
  const value = settingValueAt(snapshot.values, path)
  if (typeof value === 'object' && value !== null) return JSON.stringify(value, null, 2)
  return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean'
    ? String(value)
    : ''
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

function invalidDraft(kind: PluginFieldKind, draft: Draft): boolean {
  if (draft.clear || draft.text.trim() === '') return false
  if (kind === 'number') return !isFiniteNumber(draft.text)
  if (kind !== 'object' && kind !== 'array') return false
  try {
    const value: unknown = JSON.parse(draft.text, (_key: string, entry: unknown): unknown => {
      if (typeof entry === 'number' && !Number.isFinite(entry)) throw new Error('Non-finite JSON number')
      return entry
    })
    return kind === 'array'
      ? !Array.isArray(value)
      : typeof value !== 'object' || value === null || Array.isArray(value)
  } catch {
    return true
  }
}

function withoutNamespace(
  drafts: Readonly<Record<string, Draft>>,
  namespace: string,
): Readonly<Record<string, Draft>> {
  return Object.fromEntries(Object.entries(drafts).filter(([key]) => !key.startsWith(`${namespace}.`)))
}
