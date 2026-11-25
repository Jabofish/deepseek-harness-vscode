import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import type {
  JobView,
  PermissionRequest,
  SessionSummary,
  SubagentCatalog,
  SubagentLiveActivity,
  SubagentView,
  UserQuestion,
} from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
import { Icon } from '../../ui/Icon.js'
import {
  aggregateLoadedChildren,
  childEntries,
  flattenSubagentCatalog,
  formatSubagentDuration,
  formatTokens,
  isSubagentRunning,
  subagentActivityHeading,
  subagentDisplayLabel,
  subagentDotState,
  subagentDurationMs,
  subagentModeLabel,
  subagentTokenTotal,
} from './subagent-display.js'

export interface SubagentCatalogProps {
  /** Owner of the direct-child catalog, including an empty catalog. */
  readonly parentSessionId: string
  /** Direct-child catalog of the active session, already held in app state. */
  readonly catalog: SubagentCatalog
  /** Session-list summaries used for the official token and duration metrics. */
  readonly summaries?: readonly SessionSummary[]
  /** Bounded Host-derived live activity headings keyed by child session id. */
  readonly activities?: Readonly<Record<string, SubagentLiveActivity>>
  /** Active session jobs (used for producer-owned background subagent progress fallback). */
  readonly jobs?: readonly JobView[]
  /** Live pending permission requests across sessions. */
  readonly permissions?: readonly PermissionRequest[]
  /** Live pending user questions across sessions. */
  readonly questions?: readonly UserQuestion[]
  /** Lazily fetch one parent's catalog level (`subagent.list`). */
  readonly onLoadChildren: (sessionId: string) => Promise<SubagentCatalog | undefined>
  /** Open one child session for viewing, as upstream's `openChild`. */
  readonly onOpenChild: (entry: SubagentView, parentAvailable: boolean) => void
  /** Open one child session in a separate editor panel without leaving the parent. */
  readonly onOpenInEditor?: (entry: SubagentView) => void
  /** Interrupt one running child session directly (`subagent.interrupt`). */
  readonly onInterruptChild?: (entry: SubagentView) => Promise<void>
}

interface FloatingMenuPosition {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly maxHeight: number
}

const MENU_MAX_WIDTH = 360
const MENU_MAX_HEIGHT = 300
const VIEWPORT_GUTTER = 12
const MENU_GAP = 6
const EMPTY_SUMMARIES: readonly SessionSummary[] = []
const EMPTY_ACTIVITIES: Readonly<Record<string, SubagentLiveActivity>> = {}

/** Compact session-header catalog for navigating direct and nested subagents. */
export function SubagentDrawer(props: SubagentCatalogProps): ReactElement | null {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [catalogs, setCatalogs] = useState<Record<string, SubagentCatalog>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [stoppingIds, setStoppingIds] = useState<ReadonlySet<string>>(() => new Set())
  const [stopError, setStopError] = useState<string>()
  const [loadErrors, setLoadErrors] = useState<ReadonlySet<string>>(() => new Set())
  const [menuPosition, setMenuPosition] = useState<FloatingMenuPosition | undefined>()
  const [now, setNow] = useState(() => Date.now())
  /** The row the user last moved focus to; owns the tree's single tab stop. */
  const [activeRowId, setActiveRowId] = useState<string | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const children = useMemo(() => childEntries(props.catalog), [props.catalog])
  const summaries = props.summaries ?? EMPTY_SUMMARIES
  const activities = props.activities ?? EMPTY_ACTIVITIES
  const summariesById = useMemo(() => {
    const result = new Map<string, SessionSummary>()
    for (const summary of summaries) result.set(summary.id, summary)
    return result
  }, [summaries])

  const loadedAggregate = useMemo(
    () => aggregateLoadedChildren(props.catalog, catalogs),
    [catalogs, props.catalog],
  )
  const runningCount = loadedAggregate.running
  const diagnosticCount = props.catalog.entries.length - children.length

  useDismissibleLayer({
    open,
    refs: [rootRef, menuRef],
    onDismiss: () => setOpen(false),
    onEscape: () => {
      setOpen(false)
      triggerRef.current?.focus()
    },
  })

  useEffect(() => {
    if (!open || runningCount === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [open, runningCount])

  useEffect(() => {
    if (!open) return
    const reposition = (): void => setMenuPosition(measureFloatingMenu(triggerRef.current))
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open])

  const toggleBranch = (entry: SubagentView): void => {
    const expanding = !expanded.has(entry.id)
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(entry.id)) next.delete(entry.id)
      else next.add(entry.id)
      return next
    })
    if (expanding && catalogs[entry.id] === undefined && !busy.has(entry.id)) {
      setBusy((current) => new Set(current).add(entry.id))
      setLoadErrors((current) => {
        const next = new Set(current)
        next.delete(entry.id)
        return next
      })
      void props
        .onLoadChildren(entry.id)
        .then((loaded) => {
          if (loaded === undefined) throw new Error('Subagent catalog is unavailable.')
          setCatalogs((current) => ({ ...current, [entry.id]: loaded }))
        })
        .catch(() => {
          setLoadErrors((current) => new Set(current).add(entry.id))
        })
        .finally(() => {
          setBusy((current) => {
            const next = new Set(current)
            next.delete(entry.id)
            return next
          })
        })
    }
  }

  const treeitems = (): HTMLElement[] =>
    rootRef.current === null
      ? []
      : Array.from(
          rootRef.current.querySelectorAll<HTMLElement>('[role="treeitem"]:not([aria-disabled="true"])'),
        )

  const focusAt = (index: number): void => {
    const items = treeitems()
    if (items.length > 0) items[(index + items.length) % items.length]?.focus()
  }

  const navigate = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = treeitems()
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Home') {
      event.preventDefault()
      focusAt(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusAt(items.length - 1)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusAt(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusAt(index < 0 ? items.length - 1 : index - 1)
    }
  }

  const rows = useMemo(
    () => flattenSubagentCatalog(props.catalog, catalogs, expanded, 1),
    [catalogs, expanded, props.catalog],
  )
  // Arrow keys move the row tab stop. Tab reaches the current row's editor
  // action when available. Diagnostic rows never take focus.
  const firstSelectableId = rows.find((row) => row.entry.kind !== 'diagnostic')?.entry.id
  const tabStopId =
    activeRowId !== undefined &&
    rows.some((row) => row.entry.kind !== 'diagnostic' && row.entry.id === activeRowId)
      ? activeRowId
      : firstSelectableId
  if (props.catalog.entries.length === 0) return null

  const count = loadedAggregate.total
  const healthyLabel =
    runningCount > 0
      ? t('subagents.summary.running', { count, running: runningCount })
      : t('subagents.summary', { count })
  const countLabel =
    diagnosticCount === 0
      ? healthyLabel
      : `${healthyLabel}, ${t('subagents.diagnostics', { count: diagnosticCount })}`

  return (
    <div ref={rootRef} className="dsh-subagent-tree" onKeyDown={navigate}>
      <button
        ref={triggerRef}
        type="button"
        className="dsh-subagent-tree__trigger"
        aria-haspopup="tree"
        aria-expanded={open}
        aria-label={countLabel}
        onClick={() => {
          const next = !open
          if (next) setMenuPosition(measureFloatingMenu(triggerRef.current))
          setOpen(next)
          if (next)
            void Promise.resolve()
              .then(() => props.onLoadChildren(props.parentSessionId))
              .then((catalog) => {
                if (catalog === undefined) throw new Error('Subagent catalog unavailable')
                setLoadErrors((current) => {
                  const next = new Set(current)
                  next.delete(props.parentSessionId)
                  return next
                })
              })
              .catch(() => setLoadErrors((current) => new Set(current).add(props.parentSessionId)))
        }}
      >
        <Icon name="users" />
        {runningCount > 0 ? <span className="dsh-jobs-popover__dot" data-state="ongoing" /> : null}
        <span className="dsh-subagent-tree__trigger-label">{t('subagents.trigger')}</span>
        <span className="dsh-subagent-tree__trigger-count" aria-hidden="true">
          {count}
        </span>
        <Icon name="chevron-down" />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="dsh-subagent-tree__menu"
          role="tree"
          aria-label={t('subagents.tree.aria')}
          style={floatingMenuStyle(menuPosition)}
        >
          {loadErrors.has(props.parentSessionId) ? (
            <div role="alert" className="dsh-subagent-tree__error">
              <span>{t('subagents.loadFailedPlain')}</span>{' '}
              <button
                type="button"
                className="dsh-button dsh-button--secondary dsh-button--compact"
                onClick={() => {
                  setLoadErrors((current) => {
                    const next = new Set(current)
                    next.delete(props.parentSessionId)
                    return next
                  })
                  void props
                    .onLoadChildren(props.parentSessionId)
                    .then((loaded) => {
                      if (loaded === undefined) throw new Error('Subagent catalog is unavailable.')
                      setCatalogs((current) => ({ ...current, [props.parentSessionId]: loaded }))
                    })
                    .catch(() => {
                      setLoadErrors((current) => new Set(current).add(props.parentSessionId))
                    })
                }}
              >
                {t('subagents.retry')}
              </button>
            </div>
          ) : null}
          {stopError === undefined ? null : (
            <div role="alert" className="dsh-subagent-tree__error">
              {stopError}
            </div>
          )}
          {rows.map(({ entry, level, parentAvailable }) => {
            if (entry.kind === 'diagnostic') {
              const reason = t(`subagents.diagnostic.${entry.reason}`)
              return (
                <div
                  key={`diagnostic:${entry.id}`}
                  role="treeitem"
                  aria-disabled="true"
                  aria-level={level}
                  aria-label={`${entry.id} · ${reason}`}
                  title={reason}
                  className="dsh-subagent-tree__row dsh-subagent-tree__row--disabled"
                >
                  <span className="dsh-subagent-tree__spacer" />
                  <span className="dsh-jobs-popover__dot" data-state="error" />
                  <span className="dsh-subagent-tree__label">{entry.id}</span>
                  <span className="dsh-subagent-tree__meta">{reason}</span>
                </div>
              )
            }
            const branch = entry.hasChildren
            const isExpanded = expanded.has(entry.id)
            const loading = busy.has(entry.id)
            const entryLabel = subagentDisplayLabel(entry, t)
            const mode = subagentModeLabel(entry.mode, t)
            const liveActivity = activities[entry.id]
            const status = subagentActivityHeading(entry, liveActivity, t, {
              ...(props.jobs === undefined ? {} : { jobs: props.jobs }),
              ...(props.permissions === undefined ? {} : { permissions: props.permissions }),
              ...(props.questions === undefined ? {} : { questions: props.questions }),
            })
            const dot = subagentDotState(entry, liveActivity, props.permissions, props.questions)
            const availability =
              entry.mode === 'external'
                ? t('subagents.externalUnavailable')
                : entry.mode === 'continuable' && !parentAvailable
                  ? t('subagents.parentUnavailable')
                  : undefined
            const summary = summariesById.get(entry.id)
            const totalTokens = subagentTokenTotal(summary)
            const durationMs = subagentDurationMs(summary, entry.activity, now)
            const tokenMetric =
              totalTokens === undefined
                ? undefined
                : t('subagents.tokens', { count: formatTokens(totalTokens) })
            const durationMetric =
              durationMs === undefined ? undefined : formatSubagentDuration(durationMs, t)
            const metrics = [tokenMetric, durationMetric].filter(Boolean).join(' · ')
            const label = [entryLabel, mode, status, availability, metrics].filter(Boolean).join(' · ')
            return (
              <div
                key={entry.id}
                role="treeitem"
                tabIndex={entry.id === tabStopId ? 0 : -1}
                aria-level={level}
                aria-expanded={branch ? isExpanded : undefined}
                aria-label={label}
                aria-disabled={entry.mode === 'external' || undefined}
                aria-busy={loading || undefined}
                className={`dsh-subagent-tree__row${entry.mode === 'external' ? ' dsh-subagent-tree__row--disabled' : ''}`}
                onFocus={() => setActiveRowId(entry.id)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    if (entry.mode !== 'external') props.onOpenChild(entry, parentAvailable)
                  } else if (
                    (event.key === 'ArrowRight' && branch && !isExpanded) ||
                    (event.key === 'ArrowLeft' && isExpanded)
                  ) {
                    event.preventDefault()
                    toggleBranch(entry)
                  }
                }}
                onClick={() => {
                  if (entry.mode !== 'external') props.onOpenChild(entry, parentAvailable)
                }}
              >
                {branch ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    className={`dsh-subagent-tree__disclosure${isExpanded ? ' dsh-subagent-tree__disclosure--open' : ''}`}
                    aria-label={
                      isExpanded
                        ? t('subagents.branch.collapse', { label: entryLabel })
                        : t('subagents.branch.expand', { label: entryLabel })
                    }
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      toggleBranch(entry)
                    }}
                  >
                    <Icon name="chevron-right" />
                  </button>
                ) : (
                  <span className="dsh-subagent-tree__spacer" />
                )}
                <span className="dsh-jobs-popover__dot" data-state={dot} />
                <span className="dsh-subagent-tree__label">{entryLabel}</span>
                <span className="dsh-subagent-tree__meta">
                  {loading
                    ? t('subagents.loading')
                    : loadErrors.has(entry.id)
                      ? t('subagents.loadFailed')
                      : [mode, status, availability].filter(Boolean).join(' · ')}
                </span>
                {metrics === '' ? null : (
                  <span className="dsh-subagent-tree__metrics" title={metrics}>
                    {metrics}
                  </span>
                )}
                {entry.mode !== 'external' &&
                isSubagentRunning(entry) &&
                props.onInterruptChild !== undefined ? (
                  <button
                    type="button"
                    tabIndex={entry.id === tabStopId ? 0 : -1}
                    className="dsh-icon-button dsh-subagent-tree__action"
                    aria-label={t('subagents.stop', { label: entryLabel })}
                    title={t('subagents.stop', { label: entryLabel })}
                    disabled={stoppingIds.has(entry.id)}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      setStoppingIds((current) => new Set(current).add(entry.id))
                      setStopError(undefined)
                      void props
                        .onInterruptChild?.(entry)
                        .catch((reason: unknown) => {
                          setStopError(
                            reason instanceof Error ? reason.message : t('subagents.interruptFailed'),
                          )
                        })
                        .finally(() => {
                          setStoppingIds((current) => {
                            const next = new Set(current)
                            next.delete(entry.id)
                            return next
                          })
                        })
                    }}
                  >
                    <Icon name="stop" />
                  </button>
                ) : null}
                {entry.mode !== 'external' && props.onOpenInEditor !== undefined ? (
                  <button
                    type="button"
                    tabIndex={entry.id === tabStopId ? 0 : -1}
                    className="dsh-icon-button dsh-subagent-tree__action"
                    aria-label={t('subagents.openInEditor', { label: entryLabel })}
                    title={t('subagents.openInEditor', { label: entryLabel })}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      setOpen(false)
                      triggerRef.current?.focus()
                      props.onOpenInEditor?.(entry)
                    }}
                  >
                    <Icon name="open-in-editor" />
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function measureFloatingMenu(trigger: HTMLButtonElement | null): FloatingMenuPosition | undefined {
  if (trigger === null) return undefined
  const rect = trigger.getBoundingClientRect()
  const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_GUTTER * 2)
  const width = Math.min(MENU_MAX_WIDTH, availableWidth)
  const centeredLeft = rect.left + rect.width / 2 - width / 2
  const maxLeft = Math.max(VIEWPORT_GUTTER, window.innerWidth - width - VIEWPORT_GUTTER)
  const left = Math.min(Math.max(VIEWPORT_GUTTER, centeredLeft), maxLeft)
  const belowHeight = Math.max(0, window.innerHeight - rect.bottom - VIEWPORT_GUTTER - MENU_GAP)
  const aboveHeight = Math.max(0, rect.top - VIEWPORT_GUTTER - MENU_GAP)
  const opensBelow = belowHeight >= aboveHeight
  const availableHeight = opensBelow ? belowHeight : aboveHeight
  const maxHeight = Math.min(MENU_MAX_HEIGHT, availableHeight)
  const preferredTop = opensBelow ? rect.bottom + MENU_GAP : rect.top - MENU_GAP - maxHeight
  const maxTop = Math.max(VIEWPORT_GUTTER, window.innerHeight - VIEWPORT_GUTTER - maxHeight)
  return {
    top: Math.min(Math.max(VIEWPORT_GUTTER, preferredTop), maxTop),
    left,
    width,
    maxHeight,
  }
}

function floatingMenuStyle(position: FloatingMenuPosition | undefined): CSSProperties | undefined {
  if (position === undefined) return undefined
  return {
    top: position.top,
    left: position.left,
    width: position.width,
    maxHeight: position.maxHeight,
  }
}
