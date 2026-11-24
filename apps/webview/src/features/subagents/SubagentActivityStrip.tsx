import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
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
import { Icon } from '../../ui/Icon.js'
import {
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
  subagentNeedsAttention,
  subagentTokenTotal,
  type SubagentDotState,
} from './subagent-display.js'

export interface SubagentActivityStripProps {
  /** Owning parent session id for this catalog. */
  readonly parentSessionId: string
  /** Direct-child catalog for the active conversation. */
  readonly catalog: SubagentCatalog
  /** Session summaries used for token and duration metrics. */
  readonly summaries?: readonly SessionSummary[]
  /** Bounded Host-derived live activity headings keyed by child session id. */
  readonly activities?: Readonly<Record<string, SubagentLiveActivity>>
  /** Active session jobs (used for producer-owned background subagent progress fallback). */
  readonly jobs?: readonly JobView[]
  /** Live pending permission requests across sessions to highlight blocked children. */
  readonly permissions?: readonly PermissionRequest[]
  /** Live pending user questions across sessions to highlight blocked children. */
  readonly questions?: readonly UserQuestion[]
  /** Lazily fetch one parent's catalog level (`subagent.list`). */
  readonly onLoadChildren: (sessionId: string) => Promise<SubagentCatalog | undefined>
  /** Open one child conversation in the current surface. */
  readonly onOpenChild: (entry: SubagentView, parentAvailable: boolean) => void
  /** Open one child conversation in a separate editor panel without leaving the parent. */
  readonly onOpenInEditor?: (entry: SubagentView) => void
  /** Interrupt one running controllable child directly. */
  readonly onInterruptChild?: (entry: SubagentView) => Promise<void> | void
}

const EMPTY_SUMMARIES: readonly SessionSummary[] = []
const EMPTY_ACTIVITIES: Readonly<Record<string, SubagentLiveActivity>> = {}

/**
 * Inline, collapsed-by-default single-line subagent activity bar rendered inside
 * the active conversation. Updates its heading with live structured child
 * activity and constructs its detail subpanel lazily on demand.
 */
export const SubagentActivityStrip = memo(function SubagentActivityStrip(
  props: SubagentActivityStripProps,
): ReactElement | null {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [catalogs, setCatalogs] = useState<Record<string, SubagentCatalog>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [busyBranches, setBusyBranches] = useState<ReadonlySet<string>>(() => new Set())
  const [loadErrors, setLoadErrors] = useState<ReadonlySet<string>>(() => new Set())
  const [stoppingIds, setStoppingIds] = useState<ReadonlySet<string>>(() => new Set())
  const [stopError, setStopError] = useState<string | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  const triggerRef = useRef<HTMLButtonElement>(null)
  const mountedRef = useRef(true)
  const refreshGenerationRef = useRef(0)
  const panelId = useId()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const children = useMemo(() => childEntries(props.catalog), [props.catalog])
  const activities = props.activities ?? EMPTY_ACTIVITIES
  const summaries = props.summaries ?? EMPTY_SUMMARIES

  const summariesById = useMemo(() => {
    const result = new Map<string, SessionSummary>()
    for (const summary of summaries) result.set(summary.id, summary)
    return result
  }, [summaries])

  const loadedChildren = useMemo(
    () =>
      flattenSubagentCatalog(props.catalog, catalogs, new Set(Object.keys(catalogs)), 1).flatMap(
        ({ entry, level }): SubagentView[] => {
          if (entry.kind !== 'child') return []
          const status = level > 1 ? summariesById.get(entry.id)?.status : undefined
          const activity =
            entry.mode !== 'external' && Object.hasOwn(activities, entry.id)
              ? 'running'
              : status === undefined
                ? entry.activity
                : status === 'running'
                  ? 'running'
                  : 'inactive'
          return [activity === entry.activity ? entry : { ...entry, activity }]
        },
      ),
    [activities, catalogs, props.catalog, summariesById],
  )
  const loadedChildrenById = useMemo(
    () => new Map(loadedChildren.map((entry) => [entry.id, entry])),
    [loadedChildren],
  )
  const runningChildren = loadedChildren.filter(isSubagentRunning)
  const runningCount = runningChildren.length
  const total = loadedChildren.length
  const diagnosticCount = props.catalog.entries.length - children.length

  // Tick elapsed durations ONLY while the detail panel is open and a child is running.
  useEffect(() => {
    if (!open || runningCount === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [open, runningCount])

  const rows = useMemo(
    () => (open ? flattenSubagentCatalog(props.catalog, catalogs, expanded, 1) : []),
    [catalogs, expanded, open, props.catalog],
  )

  if (props.catalog.entries.length === 0) return null

  const attentionChild = loadedChildren.find(
    (entry) =>
      subagentNeedsAttention(entry, activities[entry.id], props.permissions, props.questions) !== undefined,
  )
  const hasAttention = attentionChild !== undefined
  const featured =
    attentionChild ??
    runningChildren.findLast((entry) => Object.hasOwn(activities, entry.id)) ??
    runningChildren.at(-1) ??
    loadedChildren.at(-1)
  const stripDotState: SubagentDotState = hasAttention
    ? 'warning'
    : runningCount > 0
      ? 'ongoing'
      : children.length === 0 && diagnosticCount > 0
        ? 'error'
        : 'done'

  const heading = (() => {
    if (featured === undefined) {
      return t('subagents.diagnostics', { count: diagnosticCount })
    }
    const featuredName = subagentDisplayLabel(featured, t)
    const featuredActivity = subagentActivityHeading(featured, activities[featured.id], t, {
      ...(props.jobs === undefined ? {} : { jobs: props.jobs }),
      ...(props.permissions === undefined ? {} : { permissions: props.permissions }),
      ...(props.questions === undefined ? {} : { questions: props.questions }),
    })
    if (hasAttention) {
      return t('subagents.strip.activeSingle', { name: featuredName, activity: featuredActivity })
    }
    if (runningCount > 1) {
      return t('subagents.strip.activeMultiple', {
        running: runningCount,
        name: featuredName,
        activity: featuredActivity,
      })
    }
    if (runningCount === 1) {
      return t('subagents.strip.activeSingle', { name: featuredName, activity: featuredActivity })
    }
    if (total === 1) {
      return t('subagents.strip.inactiveSingle', { name: featuredName })
    }
    return t('subagents.strip.inactiveMultiple', { count: total })
  })()

  const badgeText =
    runningCount > 0 && total > 1 ? `${runningCount}/${total}` : String(total || diagnosticCount)

  const toggleOpen = (): void => {
    const next = !open
    const generation = ++refreshGenerationRef.current
    setOpen(next)
    if (next) {
      setStopError(undefined)
      setNow(Date.now())
      void Promise.resolve()
        .then(() => props.onLoadChildren(props.parentSessionId))
        .then((catalog) => {
          if (!mountedRef.current || refreshGenerationRef.current !== generation) return
          if (catalog === undefined) throw new Error('Subagent catalog unavailable')
          setLoadErrors((current) => {
            if (!current.has(props.parentSessionId)) return current
            const updated = new Set(current)
            updated.delete(props.parentSessionId)
            return updated
          })
        })
        .catch(() => {
          if (!mountedRef.current || refreshGenerationRef.current !== generation) return
          setLoadErrors((current) => new Set(current).add(props.parentSessionId))
        })
    }
  }

  const toggleBranch = (entry: SubagentView): void => {
    const expanding = !expanded.has(entry.id)
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(entry.id)) next.delete(entry.id)
      else next.add(entry.id)
      return next
    })
    if (expanding && !busyBranches.has(entry.id)) {
      setBusyBranches((current) => new Set(current).add(entry.id))
      setLoadErrors((current) => {
        if (!current.has(entry.id)) return current
        const next = new Set(current)
        next.delete(entry.id)
        return next
      })
      void props
        .onLoadChildren(entry.id)
        .then((loaded) => {
          if (!mountedRef.current) return
          if (loaded === undefined) throw new Error('Subagent catalog unavailable')
          setCatalogs((current) => ({ ...current, [entry.id]: loaded }))
        })
        .catch(() => {
          if (!mountedRef.current) return
          setLoadErrors((current) => new Set(current).add(entry.id))
        })
        .finally(() => {
          if (!mountedRef.current) return
          setBusyBranches((current) => {
            if (!current.has(entry.id)) return current
            const next = new Set(current)
            next.delete(entry.id)
            return next
          })
        })
    }
  }

  const handleInterrupt = (entry: SubagentView): void => {
    if (props.onInterruptChild === undefined || stoppingIds.has(entry.id)) return
    setStoppingIds((current) => new Set(current).add(entry.id))
    setStopError(undefined)
    void Promise.resolve()
      .then(() => props.onInterruptChild?.(entry))
      .catch((reason: unknown) => {
        if (!mountedRef.current) return
        setStopError(reason instanceof Error ? reason.message : t('subagents.interruptFailed'))
      })
      .finally(() => {
        if (!mountedRef.current) return
        setStoppingIds((current) => {
          if (!current.has(entry.id)) return current
          const next = new Set(current)
          next.delete(entry.id)
          return next
        })
      })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
  }

  return (
    <section
      className={`dsh-subagent-strip${open ? ' dsh-subagent-strip--open' : ''}`}
      data-state={stripDotState}
      aria-label={t('subagents.strip.aria')}
      onKeyDown={handleKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        className="dsh-subagent-strip__toggle"
        aria-expanded={open}
        aria-controls={panelId}
        title={heading}
        onClick={toggleOpen}
      >
        <span className="dsh-jobs-popover__dot" data-state={stripDotState} aria-hidden="true" />
        <Icon name="users" />
        <span className="dsh-subagent-strip__heading">{heading}</span>
        <span className="dsh-subagent-strip__count" aria-hidden="true">
          {badgeText}
        </span>
        <span className="dsh-subagent-strip__chevron" aria-hidden="true">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        </span>
      </button>
      {open ? (
        <div
          id={panelId}
          className="dsh-subagent-strip__panel"
          role="region"
          aria-label={t('subagents.strip.panelAria')}
        >
          {loadErrors.has(props.parentSessionId) ? (
            <div className="dsh-subagent-strip__error" role="alert">
              {t('subagents.loadFailed')}
            </div>
          ) : null}
          {stopError === undefined ? null : (
            <div className="dsh-subagent-strip__error" role="alert">
              {stopError}
            </div>
          )}
          <ul className="dsh-subagent-strip__list">
            {rows.map(({ entry: catalogEntry, level, parentAvailable }) => {
              const entry =
                catalogEntry.kind === 'child'
                  ? (loadedChildrenById.get(catalogEntry.id) ?? catalogEntry)
                  : catalogEntry
              const indent = level > 1 ? { paddingInlineStart: `${(level - 1) * 16 + 8}px` } : undefined
              if (entry.kind === 'diagnostic') {
                const reason = t(`subagents.diagnostic.${entry.reason}`)
                return (
                  <li
                    key={`diagnostic:${entry.id}`}
                    className="dsh-subagent-strip__row dsh-subagent-strip__row--disabled"
                    aria-disabled="true"
                    style={indent}
                  >
                    <span className="dsh-subagent-tree__spacer" aria-hidden="true" />
                    <span className="dsh-jobs-popover__dot" data-state="error" aria-hidden="true" />
                    <div className="dsh-subagent-strip__row-main">
                      <span className="dsh-subagent-strip__row-title">{entry.id}</span>
                      <span className="dsh-subagent-strip__row-activity">{reason}</span>
                    </div>
                  </li>
                )
              }

              const branch = entry.hasChildren
              const isExpanded = expanded.has(entry.id)
              const loadingBranch = busyBranches.has(entry.id)
              const entryLabel = subagentDisplayLabel(entry, t)
              const mode = subagentModeLabel(entry.mode, t)
              const liveActivity = activities[entry.id]
              const dot = subagentDotState(entry, liveActivity, props.permissions, props.questions)
              const activityText = loadingBranch
                ? t('subagents.loading')
                : loadErrors.has(entry.id)
                  ? t('subagents.loadFailed')
                  : subagentActivityHeading(entry, liveActivity, t, {
                      ...(props.jobs === undefined ? {} : { jobs: props.jobs }),
                      ...(props.permissions === undefined ? {} : { permissions: props.permissions }),
                      ...(props.questions === undefined ? {} : { questions: props.questions }),
                    })
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
              const metaParts = [activityText, mode, availability, durationMetric, tokenMetric].filter(
                Boolean,
              )
              const metaLine = metaParts.join(' · ')
              const canOpen = entry.mode !== 'external'
              const canStop =
                props.onInterruptChild !== undefined && isSubagentRunning(entry) && entry.mode !== 'external'
              const stopping = stoppingIds.has(entry.id)

              return (
                <li
                  key={entry.id}
                  className={`dsh-subagent-strip__row${canOpen ? '' : ' dsh-subagent-strip__row--disabled'}`}
                  style={indent}
                >
                  {branch ? (
                    <button
                      type="button"
                      className={`dsh-subagent-tree__disclosure${isExpanded ? ' dsh-subagent-tree__disclosure--open' : ''}`}
                      aria-expanded={isExpanded}
                      aria-label={
                        isExpanded
                          ? t('subagents.branch.collapse', { label: entryLabel })
                          : t('subagents.branch.expand', { label: entryLabel })
                      }
                      onClick={() => toggleBranch(entry)}
                    >
                      <Icon name="chevron-right" />
                    </button>
                  ) : (
                    <span className="dsh-subagent-tree__spacer" aria-hidden="true" />
                  )}
                  <span className="dsh-jobs-popover__dot" data-state={dot} aria-hidden="true" />
                  {canOpen ? (
                    <button
                      type="button"
                      className="dsh-subagent-strip__row-open"
                      title={metaLine}
                      onClick={() => props.onOpenChild(entry, parentAvailable)}
                    >
                      <span className="dsh-subagent-strip__row-title">{entryLabel}</span>
                      <span className="dsh-subagent-strip__row-activity">{metaLine}</span>
                    </button>
                  ) : (
                    <div className="dsh-subagent-strip__row-main" aria-disabled="true" title={metaLine}>
                      <span className="dsh-subagent-strip__row-title">{entryLabel}</span>
                      <span className="dsh-subagent-strip__row-activity">{metaLine}</span>
                    </div>
                  )}
                  <div className="dsh-subagent-strip__row-actions">
                    {canStop ? (
                      <button
                        type="button"
                        className="dsh-icon-button dsh-subagent-strip__action dsh-subagent-strip__action--danger"
                        disabled={stopping}
                        aria-label={t('subagents.stopChild', { label: entryLabel })}
                        title={t('subagents.stopChild', { label: entryLabel })}
                        onClick={() => handleInterrupt(entry)}
                      >
                        <Icon name="stop" />
                      </button>
                    ) : null}
                    {canOpen && props.onOpenInEditor !== undefined ? (
                      <button
                        type="button"
                        className="dsh-icon-button dsh-subagent-strip__action"
                        aria-label={t('subagents.openInEditor', { label: entryLabel })}
                        title={t('subagents.openInEditor', { label: entryLabel })}
                        onClick={() => props.onOpenInEditor?.(entry)}
                      >
                        <Icon name="open-in-editor" />
                      </button>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </section>
  )
})
