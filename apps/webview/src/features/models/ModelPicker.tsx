import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import type { ModelDescriptor, ModelSelection } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

type ModelPane = 'root' | 'models' | 'effort'

interface ProviderGroup {
  readonly id: string
  readonly models: readonly ModelDescriptor[]
}

export interface ModelPickerProps {
  readonly models: readonly ModelDescriptor[]
  readonly value: ModelSelection
  readonly disabled?: boolean
  readonly displayLabel?: boolean
  readonly openRequest?: number
  readonly onChange: (value: ModelSelection) => void
}

/**
 * Session-scoped two-level model selector. The directory is supplied by the
 * host; provider ids are displayed as group headings and reasoning levels are
 * read from the selected model's advertised metadata. No provider/model
 * vocabulary is maintained in the Webview.
 */
export function ModelPicker(props: ModelPickerProps): ReactElement {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<ModelPane>('root')
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const selected = props.models.find(
    (model) => model.providerId === props.value.providerId && model.id === props.value.modelId,
  )
  const groups = groupModels(props.models)
  const reasoningLevels = selected?.supportsReasoning ? (selected.reasoningLevels ?? []) : []
  const effectiveReasoningLevel = props.value.reasoningLevel ?? reasoningLevels[0]
  const currentLabel =
    selected === undefined
      ? props.value.modelId.trim() === ''
        ? t('model.default')
        : t('model.unavailable', { label: props.value.modelId })
      : reasoningLevels.length === 0 || effectiveReasoningLevel === undefined
        ? selected.label
        : `${selected.label} · ${effectiveReasoningLevel}`

  const close = useCallback((): void => {
    setOpen(false)
    setPane('root')
  }, [])

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && !rootRef.current?.contains(target)) close()
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [close, open])

  useEffect(() => {
    if ((props.openRequest ?? 0) <= 0 || props.disabled || props.models.length === 0) return
    const openPicker = window.setTimeout(() => {
      setPane('root')
      setOpen(true)
      triggerRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(openPicker)
  }, [props.disabled, props.models.length, props.openRequest])

  const moveFocus = (offset: number): void => {
    const items =
      rootRef.current === null
        ? []
        : Array.from(
            rootRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]'),
          )
    if (items.length === 0) return
    const active = items.findIndex((item) => item === document.activeElement)
    const next = (Math.max(active, 0) + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (pane === 'root') {
        close()
        triggerRef.current?.focus()
      } else {
        setPane('root')
      }
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const selectModel = (model: ModelDescriptor): void => {
    const levels = model.supportsReasoning ? (model.reasoningLevels ?? []) : []
    const sameRoute = props.value.providerId === model.providerId && props.value.modelId === model.id
    const reasoningLevel = sameRoute ? props.value.reasoningLevel : levels[0]
    props.onChange({
      providerId: model.providerId,
      modelId: model.id,
      ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
    })
    close()
  }

  const selectReasoningLevel = (reasoningLevel: string): void => {
    if (selected === undefined) return
    props.onChange({
      providerId: selected.providerId,
      modelId: selected.id,
      reasoningLevel,
    })
    close()
  }

  return (
    <div
      ref={rootRef}
      className={`dsh-compact-picker dsh-compact-picker--labelled dsh-model-picker${open ? ' dsh-compact-picker--open' : ''}`}
    >
      <button
        ref={triggerRef}
        className="dsh-compact-picker__trigger"
        type="button"
        aria-label={`${t('model.aria')}: ${currentLabel}`}
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`${t('model.select')}: ${currentLabel}`}
        disabled={props.disabled === true || props.models.length === 0}
        onClick={() => {
          if (open) close()
          else {
            setPane('root')
            setOpen(true)
          }
        }}
      >
        <Icon name="model" />
        <span className="dsh-compact-picker__trigger-text">{currentLabel}</span>
        <span className="dsh-compact-picker__trigger-label">{currentLabel}</span>
      </button>
      {open ? (
        <div
          id={menuId}
          className="dsh-compact-picker__menu dsh-model-picker__menu"
          role="menu"
          aria-label={t('model.select')}
          onKeyDown={onMenuKeyDown}
        >
          {pane === 'root' ? (
            <>
              <button
                className="dsh-model-picker__row"
                type="button"
                role="menuitem"
                onClick={() => setPane('models')}
              >
                <span>{t('model.menuModel')}</span>
                <span className="dsh-model-picker__row-value">{selected?.label ?? t('model.default')}</span>
                <Icon name="chevron-right" />
              </button>
              {reasoningLevels.length === 0 ? null : (
                <button
                  className="dsh-model-picker__row"
                  type="button"
                  role="menuitem"
                  onClick={() => setPane('effort')}
                >
                  <span>{t('model.menuEffort')}</span>
                  <span className="dsh-model-picker__row-value">
                    {effectiveReasoningLevel ?? t('model.defaultEffort')}
                  </span>
                  <Icon name="chevron-right" />
                </button>
              )}
            </>
          ) : (
            <>
              <button
                className="dsh-model-picker__back"
                type="button"
                role="menuitem"
                onClick={() => setPane('root')}
              >
                <Icon name="chevron-left" />
                <span>{t('model.back')}</span>
              </button>
              {pane === 'models' ? (
                groups.length === 0 ? (
                  <p className="dsh-model-picker__empty" role="status">
                    {t('model.noModels')}
                  </p>
                ) : (
                  groups.map((group) => (
                    <section
                      className="dsh-model-picker__group"
                      key={group.id}
                      role="group"
                      aria-label={group.id}
                    >
                      <h3>{group.id}</h3>
                      {group.models.map((model) => {
                        const isSelected =
                          model.providerId === props.value.providerId && model.id === props.value.modelId
                        return (
                          <button
                            className={`dsh-compact-picker__option${
                              isSelected ? ' dsh-compact-picker__option--selected' : ''
                            }`}
                            key={model.id}
                            type="button"
                            role="menuitemradio"
                            aria-checked={isSelected}
                            onClick={() => selectModel(model)}
                          >
                            <span>{model.label}</span>
                            {isSelected ? <Icon name="check" /> : null}
                          </button>
                        )
                      })}
                    </section>
                  ))
                )
              ) : reasoningLevels.length === 0 ? (
                <p className="dsh-model-picker__empty" role="status">
                  {t('model.noEfforts')}
                </p>
              ) : (
                reasoningLevels.map((reasoningLevel) => {
                  const isSelected = effectiveReasoningLevel === reasoningLevel
                  return (
                    <button
                      className={`dsh-compact-picker__option${
                        isSelected ? ' dsh-compact-picker__option--selected' : ''
                      }`}
                      key={reasoningLevel}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isSelected}
                      onClick={() => selectReasoningLevel(reasoningLevel)}
                    >
                      <span>{reasoningLevel}</span>
                      {isSelected ? <Icon name="check" /> : null}
                    </button>
                  )
                })
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

function groupModels(models: readonly ModelDescriptor[]): readonly ProviderGroup[] {
  const groups: ProviderGroup[] = []
  const byProvider = new Map<string, ModelDescriptor[]>()
  for (const model of models) {
    const providerId = model.providerId.trim()
    if (providerId === '') continue
    const group = byProvider.get(providerId)
    if (group === undefined) {
      const next: ModelDescriptor[] = []
      byProvider.set(providerId, next)
      groups.push({ id: providerId, models: next })
      next.push(model)
    } else {
      group.push(model)
    }
  }
  return groups
}
