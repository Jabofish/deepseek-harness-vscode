import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react'
import type { SessionSummary, SubagentCatalog, SubagentView } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface SubagentCatalogProps {
  /** Owner of the direct-child catalog, including an empty catalog. */
  readonly parentSessionId: string
  /** Direct-child catalog of the active session, already held in app state. */
  readonly catalog: SubagentCatalog
  /** Session-list summaries used for the official token and duration metrics. */
  readonly summaries?: readonly SessionSummary[]
  /** Lazily fetch one parent's catalog level (`subagent.list`). */
  readonly onLoadChildren: (sessionId: string) => Promise<SubagentCatalog | undefined>
  /** Open one child session for viewing, as upstream's `openChild`. */
  readonly onOpenChild: (entry: SubagentView, parentAvailable: boolean) => void
}

interface CatalogNode {
  readonly entry: SubagentCatalog['entries'][number]
  readonly level: number
  readonly parentAvailable: boolean
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

function isRunning(entry: SubagentView): boolean {
  return entry.activity === 'running'
}

function childEntries(catalog: SubagentCatalog): readonly SubagentView[] {
  return catalog.entries.filter((entry): entry is SubagentView => entry.kind === 'child')
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function formatTokens(value: number): string {
  const scaled = (next: number): string =>
    next >= 100 ? String(Math.round(next)) : String(Math.round(next * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`
  return `${scaled(value / 1_000_000)}M`
}

function subagentTokenTotal(summary: SessionSummary | undefined): number | undefined {
  const usage = record(summary?.projection?.values.tokenUsage)
  if (usage === undefined) return undefined
  const input = nonNegativeInteger(usage.uncachedInputTokens ?? usage.inputTokens)
  const output = nonNegativeInteger(usage.outputTokens)
  const cacheRead = nonNegativeInteger(usage.cacheReadTokens)
  const cacheWrite = nonNegativeInteger(usage.cacheWriteTokens)
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined)
    return undefined
  return (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
}

function subagentDurationMs(
  summary: SessionSummary | undefined,
  activity: SubagentView['activity'],
  now: number,
): number | undefined {
  const timing = record(summary?.projection?.values.subagentTiming)
  if (timing === undefined) return undefined
  const settledMs = nonNegativeInteger(timing.settledMs)
  if (settledMs === undefined) return undefined
  const active = record(timing.active)
  if (active === undefined) return settledMs
  const since = nonNegativeInteger(active.since)
  const through = nonNegativeInteger(active.through)
  if (since === undefined || through === undefined) return settledMs
  const end = activity === 'running' ? now : through
  return settledMs + Math.max(0, end - since)
}

function formatSubagentDuration(ms: number, t: ReturnType<typeof useI18n>['t']): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return t('duration.hoursMinutes', { hours, minutes: String(minutes % 60).padStart(2, '0') })
  if (minutes > 0)
    return t('duration.minutesSeconds', { minutes, seconds: String(totalSeconds % 60).padStart(2, '0') })
  return t('duration.seconds', { seconds: totalSeconds })
}

interface SubagentAggregate {
  readonly total: number
  readonly running: number
}

function aggregateLoadedChildren(
  catalog: SubagentCatalog,
  catalogs: Readonly<Record<string, SubagentCatalog>>,
  visited: ReadonlySet<string> = new Set(),
): SubagentAggregate {
  let total = 0
  let running = 0
  for (const entry of childEntries(catalog)) {
    total += 1
    if (isRunning(entry)) running += 1
    const branch = catalogs[entry.id]
    if (!entry.hasChildren || branch === undefined || visited.has(entry.id)) continue
    const nextVisited = new Set(visited)
    nextVisited.add(entry.id)
    const nested = aggregateLoadedChildren(branch, catalogs, nextVisited)
    total += nested.total
    running += nested.running
  }
  return { total, running }
}

function flatten(
  catalog: SubagentCatalog,
  catalogs: Readonly<Record<string, SubagentCatalog>>,
  expanded: ReadonlySet<string>,
  level: number,
  output: CatalogNode[] = [],
): CatalogNode[] {
  for (const entry of catalog.entries) {
    output.push({ entry, level, parentAvailable: catalog.parentAvailable })
    if (entry.kind === 'child' && entry.hasChildren && expanded.has(entry.id)) {
      const branch = catalogs[entry.id]
      if (branch !== undefined) flatten(branch, catalogs, expanded, level + 1, output)
    }
  }
  return output
}

/** Compact session-header catalog for navigating direct and nested subagents. */
export function SubagentDrawer(props: SubagentCatalogProps): ReactElement | null {
  const children = childEntries(props.catalog)
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [catalogs, setCatalogs] = useState<Record<string, SubagentCatalog>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [loadErrors, setLoadErrors] = useState<ReadonlySet<string>>(() => new Set())
  const [menuPosition, setMenuPosition] = useState<FloatingMenuPosition | undefined>()
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const summaries = props.summaries ?? []

  const loadedAggregate = aggregateLoadedChildren(props.catalog, catalogs)
  const runningCount = loadedAggregate.running
  const diagnosticCount = props.catalog.entries.length - children.length

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

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
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    } else if (event.key === 'Home') {
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
  const rows = flatten(props.catalog, catalogs, expanded, 1)

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
              .catch(() => undefined)
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
          className="dsh-subagent-tree__menu"
          role="tree"
          aria-label={t('subagents.tree.aria')}
          style={floatingMenuStyle(menuPosition)}
        >
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
            const entryLabel = entry.label?.trim() || entry.id
            const mode =
              entry.mode === 'continuable' ? t('subagents.mode.continuable') : t('subagents.mode.oneShot')
            const status = isRunning(entry)
              ? t('subagents.activity.running')
              : t('subagents.activity.inactive')
            const availability =
              entry.mode === 'continuable' && !parentAvailable ? t('subagents.parentUnavailable') : undefined
            const summary = summaries.find((item) => item.id === entry.id)
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
                tabIndex={0}
                aria-level={level}
                aria-expanded={branch ? isExpanded : undefined}
                aria-label={label}
                aria-busy={loading || undefined}
                className="dsh-subagent-tree__row"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    props.onOpenChild(entry, parentAvailable)
                  } else if (
                    (event.key === 'ArrowRight' && branch && !isExpanded) ||
                    (event.key === 'ArrowLeft' && isExpanded)
                  ) {
                    event.preventDefault()
                    toggleBranch(entry)
                  }
                }}
                onClick={() => props.onOpenChild(entry, parentAvailable)}
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
                <span className="dsh-jobs-popover__dot" data-state={isRunning(entry) ? 'ongoing' : 'done'} />
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
