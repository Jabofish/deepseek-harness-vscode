import { useState, type ReactElement } from 'react'
import type { DiscoveredModel, ModelDiscoveryInput } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'
import { useI18n } from '../../i18n.js'

/** A model draft keeps fields the host may add even when this UI does not edit them. */
export interface EditableModel {
  readonly id: string
  readonly name?: string
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly [key: string]: unknown
}

type ModelPatch = {
  readonly id?: string | undefined
  readonly name?: string | undefined
  readonly contextWindow?: number | undefined
  readonly maxTokens?: number | undefined
}
type CapacityField = 'contextWindow' | 'maxTokens'

export interface ModelListEditorProps {
  readonly models: readonly EditableModel[]
  readonly writable: boolean
  readonly saving: boolean
  readonly showSave?: boolean
  readonly discoveryInput: Omit<ModelDiscoveryInput, 'apiKey'>
  readonly onChange?: (models: readonly EditableModel[]) => void
  readonly onSave: (models: readonly EditableModel[]) => Promise<void>
  readonly onDiscover: (input: Omit<ModelDiscoveryInput, 'apiKey'>) => Promise<readonly DiscoveredModel[]>
}

const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/iu

export function ModelListEditor(props: ModelListEditorProps): ReactElement {
  const { t } = useI18n()
  const [draft, setDraft] = useState<EditableModel[]>(() => props.models.map(copyModel))
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const [editingCapacity, setEditingCapacity] = useState<ReadonlyMap<string, string>>(new Map())
  const [discovering, setDiscovering] = useState(false)
  const [candidates, setCandidates] = useState<readonly DiscoveredModel[] | undefined>(undefined)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)

  const replaceDraft = (next: EditableModel[]): void => {
    setDraft(next)
    props.onChange?.(next.map(copyModel))
  }

  const update = (index: number, patch: ModelPatch): void => {
    setSaved(false)
    setDraft((current) => {
      const next = current.map((model, at) => (at === index ? applyPatch(model, patch) : model))
      props.onChange?.(next.map(copyModel))
      return next
    })
  }

  const remove = (index: number): void => {
    setSaved(false)
    setDraft((current) => {
      const next = current.filter((_model, at) => at !== index)
      props.onChange?.(next.map(copyModel))
      return next
    })
    setExpanded((current) => shiftIndexes(current, index))
    setEditingCapacity((current) => shiftCapacityBuffers(current, index))
  }

  const add = (): void => {
    setSaved(false)
    replaceDraft([...draft, { id: '' }])
  }

  const discover = async (): Promise<void> => {
    setDiscovering(true)
    setError(undefined)
    try {
      const found = await props.onDiscover(props.discoveryInput)
      if (found.length === 0) {
        setCandidates(undefined)
        setError(t('settings.noDiscoveredModels'))
        return
      }
      const known = new Set(draft.map((model) => model.id.trim()).filter((id) => id !== ''))
      setCandidates(found)
      setPicked(new Set(found.filter((model) => !known.has(model.id)).map((model) => model.id)))
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t('settings.discoveryFailed'))
    } finally {
      setDiscovering(false)
    }
  }

  const closeCandidates = (): void => {
    setCandidates(undefined)
    setPicked(new Set())
  }

  const adopt = (): void => {
    if (candidates === undefined) return
    const existing = new Set(draft.map((model) => model.id.trim()))
    const additions = candidates
      .filter((model) => picked.has(model.id) && !existing.has(model.id))
      .map((model) => ({
        id: model.id,
        ...(model.label === model.id ? {} : { name: model.label }),
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      }))
    setSaved(false)
    replaceDraft([...draft, ...additions])
    closeCandidates()
  }

  const save = async (): Promise<void> => {
    setError(undefined)
    const failure = validateDraft(draft, editingCapacity)
    if (failure !== undefined) {
      setError(
        failure.kind === 'id'
          ? t('settings.modelIdRequired')
          : t('settings.invalidCapacity', { field: t(`settings.${failure.field}`) }),
      )
      return
    }
    setSaved(false)
    try {
      await props.onSave(draft.map(normalizeModel))
      setEditingCapacity(new Map())
      setSaved(true)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
    }
  }

  return (
    <section className="dsh-settings__model-editor" aria-label={t('settings.modelsEditor')}>
      <div className="dsh-settings__model-editor-head">
        <strong>{t('settings.modelsEditor')}</strong>
        <div className="dsh-settings__model-editor-actions">
          <button
            className="dsh-button dsh-button--secondary dsh-button--compact"
            type="button"
            disabled={!props.writable || props.saving || discovering}
            onClick={() => void discover()}
          >
            <Icon name="refresh" />
            {discovering ? t('settings.fetchingModels') : t('settings.fetchModels')}
          </button>
          <button
            className="dsh-button dsh-button--secondary dsh-button--compact"
            type="button"
            disabled={!props.writable || props.saving}
            onClick={add}
          >
            <Icon name="add" />
            {t('settings.addModel')}
          </button>
        </div>
      </div>
      <p className="dsh-settings__model-editor-note">{t('settings.modelsEditorNote')}</p>
      {draft.length === 0 ? <p className="dsh-settings__empty">{t('settings.noConfiguredModels')}</p> : null}
      <ul className="dsh-settings__editable-models">
        {draft.map((model, index) => {
          const open = expanded.has(index)
          return (
            <li key={`${index}:${model.id}`} className="dsh-settings__editable-model">
              <div className="dsh-settings__editable-model-row">
                <label className="dsh-settings__editable-model-id">
                  <span className="dsh-settings__visually-hidden">{t('settings.modelId')}</span>
                  <input
                    type="text"
                    value={model.id}
                    placeholder={t('settings.modelId')}
                    disabled={!props.writable || props.saving}
                    onChange={(event) => update(index, { id: event.target.value })}
                  />
                </label>
                <label className="dsh-settings__editable-model-name">
                  <span className="dsh-settings__visually-hidden">{t('settings.modelName')}</span>
                  <input
                    type="text"
                    value={model.name ?? ''}
                    placeholder={t('settings.modelName')}
                    disabled={!props.writable || props.saving}
                    onChange={(event) => update(index, { name: emptyToUndefined(event.target.value) })}
                  />
                </label>
                <button
                  className="dsh-icon-button dsh-settings__model-disclosure"
                  type="button"
                  aria-label={t('settings.modelAdvanced')}
                  aria-expanded={open}
                  title={t('settings.modelAdvanced')}
                  onClick={() => toggleIndex(setExpanded, index)}
                >
                  <Icon name="chevron-right" />
                </button>
                <button
                  className="dsh-icon-button"
                  type="button"
                  aria-label={t('settings.removeModel', { id: model.id || String(index + 1) })}
                  title={t('settings.removeModelTitle')}
                  disabled={!props.writable || props.saving}
                  onClick={() => remove(index)}
                >
                  <Icon name="close" />
                </button>
              </div>
              {open ? (
                <div className="dsh-settings__model-advanced">
                  <CapacityInput
                    field="contextWindow"
                    value={capacityText(model, index, 'contextWindow', editingCapacity)}
                    disabled={!props.writable || props.saving}
                    onChange={(value) => {
                      setEditingCapacity((current) =>
                        new Map(current).set(bufferKey(index, 'contextWindow'), value),
                      )
                      update(index, { contextWindow: parseCapacity(value) })
                    }}
                  />
                  <CapacityInput
                    field="maxTokens"
                    value={capacityText(model, index, 'maxTokens', editingCapacity)}
                    disabled={!props.writable || props.saving}
                    onChange={(value) => {
                      setEditingCapacity((current) =>
                        new Map(current).set(bufferKey(index, 'maxTokens'), value),
                      )
                      update(index, { maxTokens: parseCapacity(value) })
                    }}
                  />
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
      {error === undefined ? null : (
        <p className="dsh-settings__error" role="alert">
          {error}
        </p>
      )}
      {saved ? (
        <p className="dsh-settings__saved" role="status">
          {t('settings.modelsSaved')}
        </p>
      ) : null}
      {props.showSave === false ? null : (
        <button
          className="dsh-button dsh-button--primary dsh-button--compact"
          type="button"
          disabled={!props.writable || props.saving}
          onClick={() => void save()}
        >
          {props.saving ? t('settings.saving') : t('settings.saveModels')}
        </button>
      )}
      {candidates === undefined ? null : (
        <div className="dsh-settings__model-picker-backdrop" role="presentation">
          <section
            className="dsh-settings__model-picker"
            role="dialog"
            aria-modal="true"
            aria-label={t('settings.discoveredModels')}
          >
            <header>
              <h3>{t('settings.discoveredModels')}</h3>
              <button
                className="dsh-icon-button"
                type="button"
                aria-label={t('settings.closeDiscoveredModels')}
                onClick={closeCandidates}
              >
                <Icon name="close" />
              </button>
            </header>
            <div className="dsh-settings__model-picker-actions">
              <button
                className="dsh-button dsh-button--secondary dsh-button--compact"
                type="button"
                onClick={() => {
                  const all = candidates.every((model) => picked.has(model.id))
                  setPicked(all ? new Set() : new Set(candidates.map((model) => model.id)))
                }}
              >
                {candidates.length > 0 && candidates.every((model) => picked.has(model.id))
                  ? t('settings.deselectAllModels')
                  : t('settings.selectAllModels')}
              </button>
            </div>
            <ul>
              {candidates.map((model) => (
                <li key={model.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={picked.has(model.id)}
                      onChange={() =>
                        setPicked((current) => {
                          const next = new Set(current)
                          if (next.has(model.id)) next.delete(model.id)
                          else next.add(model.id)
                          return next
                        })
                      }
                    />
                    <span>{model.label}</span>
                    <code>{model.id}</code>
                  </label>
                </li>
              ))}
            </ul>
            <footer>
              <button
                className="dsh-button dsh-button--secondary dsh-button--compact"
                type="button"
                onClick={closeCandidates}
              >
                {t('settings.cancel')}
              </button>
              <button
                className="dsh-button dsh-button--primary dsh-button--compact"
                type="button"
                onClick={adopt}
              >
                {t('settings.addSelectedModels')}
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  )
}

function CapacityInput(props: {
  readonly field: CapacityField
  readonly value: string
  readonly disabled: boolean
  readonly onChange: (value: string) => void
}): ReactElement {
  const { t } = useI18n()
  return (
    <label className="dsh-settings__model-field">
      <span>{t(`settings.${props.field}`)}</span>
      <input
        type="text"
        inputMode="numeric"
        value={props.value}
        placeholder={props.field === 'contextWindow' ? '256K' : '32K'}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  )
}

function parseCapacity(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const match = CAPACITY_PATTERN.exec(trimmed)
  if (match === null) return Number.NaN
  const suffix = match[2]?.toLowerCase()
  const scale = suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1
  const value = Number(match[1]) * scale
  return Number.isSafeInteger(value) && value > 0 ? value : Number.NaN
}

function formatCapacity(value: number | undefined): string {
  if (value === undefined) return ''
  if (Number.isInteger(value) && value % 1_000_000 === 0) return `${value / 1_000_000}M`
  if (Number.isInteger(value) && value % 1_000 === 0) return `${value / 1_000}K`
  return String(value)
}

function validateDraft(
  models: readonly EditableModel[],
  buffers: ReadonlyMap<string, string>,
): { readonly kind: 'id' } | { readonly kind: 'capacity'; readonly field: CapacityField } | undefined {
  const ids = new Set<string>()
  for (const [index, model] of models.entries()) {
    const id = model.id.trim()
    if (id === '' || ids.has(id)) return { kind: 'id' }
    ids.add(id)
    for (const field of ['contextWindow', 'maxTokens'] as const) {
      const buffer = buffers.get(bufferKey(index, field))
      if (buffer !== undefined && buffer.trim() !== '' && Number.isNaN(parseCapacity(buffer))) {
        return { kind: 'capacity', field }
      }
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

function copyModel(model: EditableModel): EditableModel {
  return { ...model }
}

function applyPatch(model: EditableModel, patch: ModelPatch): EditableModel {
  const next: Record<string, unknown> = { ...model }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  if (typeof next.id !== 'string') next.id = ''
  return next as EditableModel
}

function emptyToUndefined(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : value
}

function bufferKey(index: number, field: CapacityField): string {
  return `${index}:${field}`
}

function capacityText(
  model: EditableModel,
  index: number,
  field: CapacityField,
  buffers: ReadonlyMap<string, string>,
): string {
  return buffers.get(bufferKey(index, field)) ?? formatCapacity(model[field])
}

function toggleIndex(
  setter: (value: (current: ReadonlySet<number>) => Set<number>) => void,
  index: number,
): void {
  setter((current) => {
    const next = new Set(current)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    return next
  })
}

function shiftIndexes(current: ReadonlySet<number>, removed: number): Set<number> {
  const next = new Set<number>()
  for (const index of current) {
    if (index < removed) next.add(index)
    else if (index > removed) next.add(index - 1)
  }
  return next
}

function shiftCapacityBuffers(current: ReadonlyMap<string, string>, removed: number): Map<string, string> {
  const next = new Map<string, string>()
  for (const [key, value] of current) {
    const separator = key.indexOf(':')
    const index = Number(key.slice(0, separator))
    if (index === removed) continue
    next.set(index > removed ? `${index - 1}${key.slice(separator)}` : key, value)
  }
  return next
}
