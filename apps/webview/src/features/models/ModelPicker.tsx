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
import { useConversationLayout } from '../../app/ConversationLayoutProvider.js'
import { rankByName } from './rank-by-name.js'

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
  /** True while the session directory is being read; the menu states it. */
  readonly loading?: boolean
  /**
   * The host's own reason the session directory could not be read. A refused
   * read is not an empty directory: the rows on screen may be the global
   * catalog, so the menu has to say why the session's own directory is missing.
   */
  readonly error?: string
  /** Re-read the directory; omitted means this surface cannot retry. */
  readonly onRetry?: () => void
  readonly value: ModelSelection
  readonly disabled?: boolean
  readonly displayLabel?: boolean
  readonly showIcon?: boolean
  readonly openRequest?: number
  readonly onChange: (value: ModelSelection) => void | Promise<void>
}

/**
 * Session-scoped two-level model selector. The directory is supplied by the
 * host; provider ids are displayed as group headings and reasoning levels are
 * read from the selected model's advertised metadata. No provider/model
 * vocabulary is maintained in the Webview.
 */
export const ModelPicker = memo(function ModelPicker(props: ModelPickerProps): ReactElement {
  const { t } = useI18n()
  const focused = useConversationLayout()?.layout === 'focused'
  const [search, setSearch] = useState<{ readonly query: string; readonly index?: number }>({ query: '' })
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<ModelPane>('root')
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState(false)
  const applyingRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const failures = props.failures ?? EMPTY_FAILURES
  /**
   * The directory's state decides what the menu may say about the rows:
   * "no models" is a verdict only an answered directory can make, so it is
   * withheld while the read is still running or has failed. The trigger itself
   * never dies on an unanswered directory — the menu is where the reason lives.
   */
  const answeredEmpty =
    props.models.length === 0 && failures.length === 0 && props.loading !== true && props.error === undefined
  /** Where the next open should land the keyboard cursor. */
  const openEntryRef = useRef<'first' | 'last'>('first')
  const returnPaneRef = useRef<ModelPane | undefined>(undefined)
  /**
   * Requests are one-shot: the counter stays above zero for the rest of the
   * session, so a value seen at mount is already spent and a remount must not
   * spend it again.
   */
  const consumedRequestRef = useRef(props.openRequest ?? 0)
  const selected = props.models.find(
    (model) => model.providerId === props.value.providerId && model.id === props.value.modelId,
  )
  const showSearch = focused && props.models.length > 4
  const groups = useMemo(
    () =>
      groupModels(props.models)
        .map((group) => ({
          ...group,
          models: showSearch
            ? rankByName(
                group.models.map((model) => ({ ...model, name: model.id })),
                search.query.trim(),
              )
            : group.models,
        }))
        .filter((group) => group.models.length > 0),
    [props.models, search.query, showSearch],
  )
  const visibleModels = useMemo(() => groups.flatMap((group) => group.models), [groups])
  const currentIndex = visibleModels.findIndex(
    (model) => model.providerId === props.value.providerId && model.id === props.value.modelId,
  )
  const activeIndex = Math.min(search.index ?? Math.max(0, currentIndex), visibleModels.length - 1)
  const reasoningLevels = selected?.supportsReasoning ? (selected.reasoningLevels ?? []) : []
  /**
   * The effort in effect, as far as the host has stated it: an explicitly
   * selected level, else the level the adapter declares as its default. The
   * first advertised level is neither of those — an adapter that states no
   * default resolves the effort itself, and naming one of its levels would
   * report an effort the session may not be running.
   */
  const effectiveReasoningLevel = props.value.reasoningLevel ?? selected?.defaultReasoningLevel
  const effortLabel =
    reasoningLevels.length === 0
      ? undefined
      : effectiveReasoningLevel === undefined
        ? t('model.defaultEffort')
        : (reasoningLevels.find((level) => level.id === effectiveReasoningLevel)?.label ??
          effectiveReasoningLevel)
  /**
   * The model half of the label. A selection the directory does not list is a
   * route this picker cannot name — not a verdict: the catalog is advisory, a
   * provider that could not enumerate reports its reason as a menu warning
   * row, and the host states whether the session routes at all. Until the
   * directory can name the route, the host's own identifiers stand in.
   */
  const routeLabel =
    selected === undefined
      ? props.value.modelId.trim() === ''
        ? t('model.default')
        : `${props.value.providerId}/${props.value.modelId}`
      : selected.label
  const currentLabel = effortLabel === undefined ? routeLabel : `${routeLabel} · ${effortLabel}`
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
    returnPaneRef.current = undefined
  }, [])

  const back = (): void => {
    returnPaneRef.current = pane
    setPane('root')
  }

  const hasSelection = selected !== undefined
  const openMenu = useCallback(
    (entry: 'first' | 'last' = 'first'): void => {
      openEntryRef.current = entry
      setSearch({ query: '' })
      setPane(focused && !hasSelection ? 'models' : 'root')
      setOpen(true)
    },
    [focused, hasSelection],
  )

  /**
   * Every surface of this menu is keyboard-reachable: opening it and switching
   * panes both land the cursor on a row, otherwise the arrow handlers never see
   * a keydown because focus fell back to the document body.
   */
  useLayoutEffect(() => {
    if (!open) return
    if (pane === 'models' && showSearch) {
      searchRef.current?.focus()
      return
    }
    const items = menuItems(menuRef.current)
    if (items.length === 0) return
    const entry = openEntryRef.current
    openEntryRef.current = 'first'
    const returnedPane = returnPaneRef.current
    returnPaneRef.current = undefined
    const checked =
      focused && pane !== 'root'
        ? menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')
        : undefined
    const index =
      focused && pane === 'root' && returnedPane === 'effort' ? 1 : entry === 'last' ? items.length - 1 : 0
    ;(checked ?? items[index])?.focus()
  }, [focused, open, pane, showSearch])

  useLayoutEffect(() => {
    if (open && pane === 'models' && showSearch && activeIndex >= 0)
      document.getElementById(`${menuId}-model-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, menuId, open, pane, showSearch, visibleModels])

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
    // The menu can always state where the directory stands, so a requested
    // open is spent as soon as the control is usable at all.
    if (props.disabled === true) return
    let retired = false
    queueMicrotask(() => {
      if (retired) return
      consumedRequestRef.current = request
      openMenu()
      triggerRef.current?.focus()
    })
    return () => {
      retired = true
    }
  }, [openMenu, props.disabled, props.openRequest])

  const moveFocus = (offset: number): void => {
    const items = menuItems(menuRef.current)
    if (items.length === 0) return
    const active = items.findIndex((item) => item === document.activeElement)
    const next = (Math.max(active, 0) + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (applying) return
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    openMenu(event.key === 'ArrowDown' ? 'first' : 'last')
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' || (focused && event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault()
      if (pane === 'root' || (focused && selected === undefined)) {
        close()
        triggerRef.current?.focus()
      } else {
        back()
      }
      return
    }
    if (showSearch && pane === 'models') {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (!applying && visibleModels.length > 0)
          setSearch({
            ...search,
            index:
              (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + visibleModels.length) %
              visibleModels.length,
          })
        searchRef.current?.focus()
        return
      }
      if (event.target === searchRef.current && (event.key === 'Enter' || event.key === 'Tab')) {
        if (event.key === 'Tab' && visibleModels.length === 0) return
        event.preventDefault()
        const model = visibleModels[activeIndex]
        if (!applying && model !== undefined) selectModel(model)
        return
      }
    }
    if (focused && event.key === 'Tab') {
      const target = event.target
      if (target instanceof HTMLButtonElement && menuItems(menuRef.current).includes(target)) {
        event.preventDefault()
        target.click()
      }
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const applySelection = (value: ModelSelection): void => {
    if (applyingRef.current) return
    setApplyError(false)
    let result: void | Promise<void>
    try {
      result = props.onChange(value)
    } catch {
      setApplyError(true)
      return
    }
    const finish = (): void => {
      close()
      triggerRef.current?.focus()
    }
    if (result === undefined) {
      finish()
      return
    }
    applyingRef.current = true
    setApplying(true)
    void result
      .then(finish)
      .catch(() => setApplyError(true))
      .finally(() => {
        applyingRef.current = false
        setApplying(false)
      })
  }

  const selectModel = (model: ModelDescriptor): void => {
    const sameRoute = props.value.providerId === model.providerId && props.value.modelId === model.id
    // Choosing a route states the route alone: the adapter resolves the effort
    // for a model it has not been asked about yet, while a level the session
    // already carries survives re-picking the model it belongs to.
    const reasoningLevel = sameRoute ? props.value.reasoningLevel : undefined
    applySelection({
      providerId: model.providerId,
      modelId: model.id,
      ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
    })
  }

  const selectReasoningLevel = (reasoningLevel: string | undefined): void => {
    if (selected === undefined) return
    applySelection({
      providerId: selected.providerId,
      modelId: selected.id,
      ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
    })
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
        disabled={props.disabled === true}
        aria-disabled={applying}
        onClick={() => {
          if (applying) return
          if (open) close()
          else openMenu()
        }}
        onKeyDown={onTriggerKeyDown}
      >
        {props.showIcon === false ? null : <Icon name="model" />}
        <span className="dsh-select-menu__trigger-text">{currentLabel}</span>
        <span className="dsh-select-menu__trigger-label">{currentLabel}</span>
        <Icon name="chevron-down" className="dsh-select-menu__chevron" />
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          className="dsh-select-menu__menu dsh-model-picker__menu"
          role={focused && pane === 'models' ? 'group' : 'menu'}
          aria-label={t('model.select')}
          aria-busy={applying}
          style={menuPosition}
          onKeyDown={onMenuKeyDown}
        >
          {pane === 'root' ? null : (
            <div className="dsh-model-picker__header">
              <button
                className="dsh-model-picker__back"
                type="button"
                role={focused && pane === 'models' ? undefined : 'menuitem'}
                onClick={back}
              >
                <Icon name="chevron-left" />
                <span>{t('model.back')}</span>
              </button>
              {pane === 'models' && showSearch ? (
                <div className="dsh-model-picker__search-row">
                  <input
                    ref={searchRef}
                    type="text"
                    role="searchbox"
                    className="dsh-model-picker__search"
                    aria-label={t('model.search')}
                    placeholder={t('model.search')}
                    aria-controls={`${menuId}-models`}
                    aria-activedescendant={activeIndex < 0 ? undefined : `${menuId}-model-${activeIndex}`}
                    value={search.query}
                    readOnly={applying}
                    maxLength={160}
                    onChange={(event) => setSearch({ query: event.currentTarget.value, index: 0 })}
                  />
                  {search.query === '' ? null : (
                    <button
                      type="button"
                      className="dsh-icon-button"
                      aria-label={t('model.clearSearch')}
                      disabled={applying}
                      onClick={() => {
                        setSearch({ query: '', index: 0 })
                        searchRef.current?.focus()
                      }}
                    >
                      <Icon name="close" />
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          )}
          <div className="dsh-model-picker__content">
            {pane === 'root' ? (
              <>
                <button
                  className="dsh-model-picker__row"
                  type="button"
                  role="menuitem"
                  onClick={() => setPane('models')}
                >
                  <span>{t('model.menuModel')}</span>
                  <span className="dsh-model-picker__row-value">{routeLabel}</span>
                  <Icon name="chevron-right" />
                </button>
                {effortLabel === undefined ? null : (
                  <button
                    className="dsh-model-picker__row"
                    type="button"
                    role="menuitem"
                    onClick={() => setPane('effort')}
                  >
                    <span>{t('model.menuEffort')}</span>
                    <span className="dsh-model-picker__row-value">{effortLabel}</span>
                    <Icon name="chevron-right" />
                  </button>
                )}
              </>
            ) : (
              <>
                {pane === 'models' ? (
                  <>
                    {props.loading === true ? (
                      <p className="dsh-model-picker__status" role="status">
                        {t('model.loading')}
                      </p>
                    ) : null}
                    {props.error === undefined ? null : (
                      <div className="dsh-model-picker__error">
                        <p className="dsh-model-picker__warning" role="status">
                          {t('model.loadFailed', { message: props.error })}
                        </p>
                        {props.onRetry === undefined ? null : (
                          <button
                            className="dsh-button dsh-button--secondary dsh-button--compact"
                            type="button"
                            onClick={props.onRetry}
                          >
                            {t('model.retry')}
                          </button>
                        )}
                      </div>
                    )}
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
                    <div
                      id={`${menuId}-models`}
                      className="dsh-model-picker__groups"
                      role={focused && groups.length > 0 ? 'menu' : undefined}
                      aria-label={focused && groups.length > 0 ? t('model.menuModel') : undefined}
                    >
                      {groups.length === 0 ? (
                        showSearch && search.query.trim() !== '' ? (
                          <p role="status" className="dsh-model-picker__empty">
                            {t('model.noMatches')}
                          </p>
                        ) : answeredEmpty ? (
                          <p className="dsh-model-picker__empty" role="status">
                            {t('model.noModels')}
                          </p>
                        ) : null
                      ) : (
                        groups.map((group) => (
                          <section
                            className="dsh-model-picker__group"
                            key={group.id}
                            role="group"
                            aria-label={group.id}
                          >
                            {focused ? (
                              <div className="dsh-model-picker__group-heading" title={group.id}>
                                {group.id}
                              </div>
                            ) : (
                              <h3 title={group.id}>{group.id}</h3>
                            )}
                            {group.models.map((model) => {
                              const isSelected =
                                model.providerId === props.value.providerId &&
                                model.id === props.value.modelId
                              return (
                                <button
                                  className={`dsh-select-menu__option${
                                    isSelected ? ' dsh-select-menu__option--selected' : ''
                                  }`}
                                  key={model.id}
                                  type="button"
                                  role="menuitemradio"
                                  id={`${menuId}-model-${visibleModels.indexOf(model)}`}
                                  tabIndex={showSearch ? -1 : 0}
                                  data-highlighted={
                                    showSearch && visibleModels.indexOf(model) === activeIndex
                                      ? 'true'
                                      : undefined
                                  }
                                  onMouseMove={
                                    showSearch && !applying
                                      ? () => setSearch({ ...search, index: visibleModels.indexOf(model) })
                                      : undefined
                                  }
                                  aria-checked={isSelected}
                                  aria-disabled={applying}
                                  title={model.label}
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
                    </div>
                  </>
                ) : (
                  <>
                    {selected === undefined || selected.defaultReasoningLevel !== undefined ? null : (
                      <button
                        className={`dsh-select-menu__option${
                          effectiveReasoningLevel === undefined ? ' dsh-select-menu__option--selected' : ''
                        }`}
                        type="button"
                        role="menuitemradio"
                        aria-checked={effectiveReasoningLevel === undefined}
                        aria-disabled={applying}
                        onClick={() => selectReasoningLevel(undefined)}
                      >
                        <span>{t('model.defaultEffort')}</span>
                        {effectiveReasoningLevel === undefined ? <Icon name="check" /> : null}
                      </button>
                    )}
                    {reasoningLevels.map((reasoningLevel) => {
                      const isSelected = effectiveReasoningLevel === reasoningLevel.id
                      return (
                        <button
                          className={`dsh-select-menu__option${
                            isSelected ? ' dsh-select-menu__option--selected' : ''
                          }`}
                          key={reasoningLevel.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isSelected}
                          aria-disabled={applying}
                          onClick={() => selectReasoningLevel(reasoningLevel.id)}
                        >
                          <span>{reasoningLevel.label}</span>
                          {isSelected ? <Icon name="check" /> : null}
                        </button>
                      )
                    })}
                  </>
                )}
              </>
            )}
          </div>
          {applying || applyError ? (
            <div className="dsh-model-picker__feedback">
              {applying ? (
                <p className="dsh-model-picker__status" role="status">
                  {t('model.applying')}
                </p>
              ) : applyError ? (
                <p className="dsh-model-picker__warning" role="alert">
                  {t('model.applyFailed')}
                </p>
              ) : null}
            </div>
          ) : null}
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
