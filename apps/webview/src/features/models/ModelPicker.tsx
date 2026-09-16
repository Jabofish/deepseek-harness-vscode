import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  memo,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import type { ModelCatalogFailure, ModelDescriptor, ModelSelection } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
import { useViewportMenuPosition } from '../../components/common/useViewportMenuPosition.js'

type ModelPane = 'root' | 'models' | 'effort'

const EMPTY_FAILURES: readonly ModelCatalogFailure[] = []

interface ProviderGroup {
  readonly id: string
  readonly models: readonly ModelDescriptor[]
}

export interface ModelPickerProps {
  readonly models: readonly ModelDescriptor[]
  /** Providers the directory could not enumerate, with the host's reason. */
  readonly failures?: readonly ModelCatalogFailure[]
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
export const ModelPicker = memo(function ModelPicker(props: ModelPickerProps): ReactElement {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<ModelPane>('root')
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const failures = props.failures ?? EMPTY_FAILURES
  /**
   * A directory with nothing to show is not the same as a failure the user
   * needs to read: the menu stays reachable while the host has something to
   * say about why the providers are missing.
   */
  const empty = props.models.length === 0 && failures.length === 0
  /** Where the next open should land the keyboard cursor. */
  const openEntryRef = useRef<'first' | 'last'>('first')
  /**
   * Requests are one-shot: the counter stays above zero for the rest of the
   * session, so a value seen at mount is already spent and a remount must not
   * spend it again.
   */
  const consumedRequestRef = useRef(props.openRequest ?? 0)
  const selected = props.models.find(
    (model) => model.providerId === props.value.providerId && model.id === props.value.modelId,
  )
  const groups = useMemo(() => groupModels(props.models), [props.models])
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
  const menuPosition = useViewportMenuPosition({
    open,
    anchorRef: triggerRef,
    menuRef,
    refreshKey: pane,
    placement: 'above',
  })

  const close = useCallback((): void => {
    setOpen(false)
    setPane('root')
  }, [])

  const openMenu = useCallback((entry: 'first' | 'last' = 'first'): void => {
    openEntryRef.current = entry
    setPane('root')
    setOpen(true)
  }, [])

  /**
   * Every surface of this menu is keyboard-reachable: opening it and switching
   * panes both land the cursor on a row, otherwise the arrow handlers never see
   * a keydown because focus fell back to the document body.
   */
  useLayoutEffect(() => {
    if (!open) return
    const items = menuItems(menuRef.current)
    if (items.length === 0) return
    const entry = openEntryRef.current
    openEntryRef.current = 'first'
    items[entry === 'last' ? items.length - 1 : 0]?.focus()
  }, [open, pane])

  useDismissibleLayer({
    open,
    refs: [rootRef, menuRef],
    onDismiss: close,
    onEscape: () => {
      close()
      triggerRef.current?.focus()
    },
  })

  useEffect(() => {
    const request = props.openRequest ?? 0
    if (request <= 0 || request <= consumedRequestRef.current) return
    // An empty directory is the one transient reason to keep waiting: the
    // request is spent only once there is something to show.
    if (props.disabled || empty) return
    const openPicker = window.setTimeout(() => {
      consumedRequestRef.current = request
      openMenu()
      triggerRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(openPicker)
  }, [empty, openMenu, props.disabled, props.openRequest])

  const moveFocus = (offset: number): void => {
    const items = menuItems(menuRef.current)
    if (items.length === 0) return
    const active = items.findIndex((item) => item === document.activeElement)
    const next = (Math.max(active, 0) + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    openMenu(event.key === 'ArrowDown' ? 'first' : 'last')
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
    triggerRef.current?.focus()
  }

  const selectReasoningLevel = (reasoningLevel: string): void => {
    if (selected === undefined) return
    props.onChange({
      providerId: selected.providerId,
      modelId: selected.id,
      reasoningLevel,
    })
    close()
    triggerRef.current?.focus()
  }

  return (
    <div
      ref={rootRef}
      className={`dsh-select-menu dsh-select-menu--labelled dsh-model-picker${open ? ' dsh-select-menu--open' : ''}`}
    >
      <button
        ref={triggerRef}
        className="dsh-select-menu__trigger"
        type="button"
        aria-label={`${t('model.aria')}: ${currentLabel}`}
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`${t('model.select')}: ${currentLabel}`}
        disabled={props.disabled === true || empty}
        onClick={() => {
          if (open) close()
          else openMenu()
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <Icon name="model" />
        <span className="dsh-select-menu__trigger-text">{currentLabel}</span>
        <span className="dsh-select-menu__trigger-label">{currentLabel}</span>
        <Icon name="chevron-down" className="dsh-select-menu__chevron" />
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          className="dsh-select-menu__menu dsh-model-picker__menu"
          role="menu"
          aria-label={t('model.select')}
          style={menuPosition}
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
                <>
                  {failures.length === 0 ? null : (
                    <div className="dsh-model-picker__failures">
                      {failures.map((failure) => (
                        <p className="dsh-model-picker__warning" role="status" key={failure.providerId}>
                          {t('model.groupLoadFailed', {
                            name: failure.providerName,
                            message: failure.message,
                          })}
                        </p>
                      ))}
                    </div>
                  )}
                  {groups.length === 0 ? (
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
                              className={`dsh-select-menu__option${
                                isSelected ? ' dsh-select-menu__option--selected' : ''
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
                  )}
                </>
              ) : reasoningLevels.length === 0 ? (
                <p className="dsh-model-picker__empty" role="status">
                  {t('model.noEfforts')}
                </p>
              ) : (
                reasoningLevels.map((reasoningLevel) => {
                  const isSelected = effectiveReasoningLevel === reasoningLevel
                  return (
                    <button
                      className={`dsh-select-menu__option${
                        isSelected ? ' dsh-select-menu__option--selected' : ''
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
})

/** Menu rows in DOM order, including the back row. */
function menuItems(menu: HTMLElement | null): readonly HTMLButtonElement[] {
  return menu === null
    ? []
    : Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]'))
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
