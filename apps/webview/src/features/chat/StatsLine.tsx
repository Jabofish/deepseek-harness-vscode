import { memo, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { SessionStatsProjection, TokenUsage } from '@dsh-vscode/domain'
import { billedInputTokens, cacheHitPercent } from '@dsh-vscode/timeline'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { useI18n } from '../../i18n.js'
import type { PerformanceUsageMode } from '../../app/ui-preferences.js'
import { StatsDetails, statisticsRows } from './StatsDetails.js'
import { StatsPopover } from './StatsPopover.js'
import { StableStatsHeight } from './StableStatsHeight.js'
import { useConversationLayout } from '../../app/ConversationLayoutProvider.js'

export interface StatsLineProps {
  /** Optional independent reading; this renderer does not own its calculation or I/O. */
  readonly cost?: (details: boolean, inline?: boolean) => ReactElement
  readonly sessionId?: string | undefined
  readonly nodes: readonly TimelineNode[]
  /** Optional reducer boundary for incremental fallback statistics. */
  readonly nodeChangeStart?: number
  readonly nodeChangeBase?: readonly TimelineNode[]
  readonly usage: TokenUsage | undefined
  readonly cacheHit: number
  /** Whole-log DSH projection; the visible-node fold is only a fallback. */
  readonly sessionStats?: SessionStatsProjection | undefined
  readonly performanceUsage?: PerformanceUsageMode
}

type WindowStats = SessionStatsProjection

interface NodeStats {
  readonly turns: number
  readonly assistantSteps: number
  readonly toolSteps: number
  readonly llmMs: number
  readonly toolMs: number
  readonly ttftMs: number
  readonly ttftSteps: number
  readonly decodeMs: number
  readonly decodeTokens: number
}

const EMPTY_NODE_STATS: NodeStats = {
  turns: 0,
  assistantSteps: 0,
  toolSteps: 0,
  llmMs: 0,
  toolMs: 0,
  ttftMs: 0,
  ttftSteps: 0,
  decodeMs: 0,
  decodeTokens: 0,
}

const nodeStatsCache = new WeakMap<object, NodeStats>()

/**
 * Sticky session statistics above the composer, mirroring the official Web
 * UI's StatsLine: counts, DSH wall-time/speed metrics, cache hit, and token
 * totals. The projection is authoritative because the visible timeline can be
 * paged or compacted.
 */
export const StatsLine = memo(function StatsLine(props: StatsLineProps): ReactElement {
  return (
    <StableStatsHeight key={props.sessionId}>
      <StatsLineContent {...props} />
    </StableStatsHeight>
  )
})

const StatsLineContent = memo(function StatsLineContent(props: StatsLineProps): ReactElement {
  const { t } = useI18n()
  const focused = useConversationLayout()?.layout === 'focused'
  const presentation = props.performanceUsage ?? 'detailed'
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width !== undefined && width > 0) setNarrow(width <= 560)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  const statsProjector = useMemo(() => createStatsProjector(), [])
  const stats = useMemo(
    () => props.sessionStats ?? statsProjector(props.nodes, props.nodeChangeStart, props.nodeChangeBase),
    [props.nodeChangeBase, props.nodeChangeStart, props.nodes, props.sessionStats, statsProjector],
  )
  if (stats.turns === 0 && props.usage === undefined)
    return <div className="dsh-stats-line" aria-hidden="true" />
  const cachePercent =
    props.usage === undefined
      ? '0'
      : (cacheHitPercent(props.usage) ?? String(Math.round(props.cacheHit * 100)))
  const tokenTotal = props.usage?.totalTokens
  const durations: string[] = []
  if (stats.llmMs > 0) durations.push(`LLM ${formatDuration(stats.llmMs)}`)
  if (stats.toolMs > 0) durations.push(`${t('stats.tool')} ${formatDuration(stats.toolMs)}`)
  const speeds: string[] = []
  if (stats.ttftSteps > 0) speeds.push(`TTFT ${formatDuration(stats.ttftMs / stats.ttftSteps)}`)
  if (stats.decodeMs > 0 && stats.decodeTokens > 0)
    speeds.push(`${formatRate(stats.decodeTokens / (stats.decodeMs / 1_000))} tk/s`)
  if (presentation === 'compact') {
    const outputSpeed =
      stats.decodeMs > 0 && stats.decodeTokens > 0
        ? `${formatRate(stats.decodeTokens / (stats.decodeMs / 1_000))} tk/s`
        : undefined
    if (outputSpeed === undefined && props.usage === undefined)
      return <div className="dsh-stats-line" aria-hidden="true" data-performance-usage="compact" />
    // A named group, not a live region: every streaming frame changes the
    // numbers, and a status role would re-read the whole line each time.
    return (
      <div
        ref={setElement}
        className="dsh-stats-line"
        role="group"
        aria-label={t('stats.aria')}
        data-performance-usage="compact"
      >
        {outputSpeed === undefined ? null : <span title={t('stats.speed')}>{outputSpeed}</span>}
        {outputSpeed !== undefined && props.usage !== undefined ? <span aria-hidden="true">·</span> : null}
        {props.usage === undefined ? null : (
          <span title={t('stats.cache')}>{t('stats.cacheShort', { percent: cachePercent })}</span>
        )}
        {narrow && props.cost !== undefined ? (
          <>
            <StatsDetails stats={stats} usage={props.usage}>
              {props.cost(true)}
            </StatsDetails>
            {props.cost(false, true)}
          </>
        ) : (
          props.cost?.(false)
        )}
      </div>
    )
  }
  if (focused) {
    const counts = [
      ...(props.sessionStats === undefined ? [t('stats.loadedWindow')] : []),
      t(stats.turns === 1 ? 'stats.turns' : 'stats.turns.plural', { count: stats.turns }),
      t(stats.steps === 1 ? 'stats.steps' : 'stats.steps.plural', { count: stats.steps }),
      ...(stats.decodeMs > 0 && stats.decodeTokens > 0
        ? [`${formatRate(stats.decodeTokens / (stats.decodeMs / 1000))} tk/s`]
        : []),
    ].join(' · ')
    const usageLabel = [
      ...(tokenTotal === undefined ? [] : [t('stats.totalTokensValue', { count: formatTokens(tokenTotal) })]),
      t('stats.cacheShort', { percent: cachePercent }),
    ].join(' · ')
    return (
      <FocusedStatsLine
        key={props.sessionId}
        counts={counts}
        usageLabel={usageLabel}
        stats={stats}
        usage={props.usage}
        narrow={narrow}
        onContainer={setElement}
        {...(props.cost === undefined ? {} : { cost: props.cost })}
      />
    )
  }
  return (
    <div
      ref={setElement}
      className="dsh-stats-line"
      role="group"
      aria-label={t('stats.aria')}
      data-performance-usage="detailed"
    >
      <StatsDetails stats={stats} usage={props.usage}>
        {narrow ? props.cost?.(true) : null}
      </StatsDetails>
      {props.sessionStats === undefined ? <span>{t('stats.loadedWindow')}</span> : null}
      <span>{t(stats.turns === 1 ? 'stats.turns' : 'stats.turns.plural', { count: stats.turns })}</span>
      <span aria-hidden="true">·</span>
      <span>{t(stats.steps === 1 ? 'stats.steps' : 'stats.steps.plural', { count: stats.steps })}</span>
      {durations.length === 0 ? null : (
        <>
          <span aria-hidden="true">·</span>
          <span title={t('stats.wallTime')}>{durations.join(' · ')}</span>
        </>
      )}
      {speeds.length === 0 ? null : (
        <>
          <span aria-hidden="true">·</span>
          <span title={t('stats.speed')}>{speeds.join(' · ')}</span>
        </>
      )}
      {props.usage === undefined ? null : (
        <>
          <span aria-hidden="true">·</span>
          <span title={t('stats.input')}>↑{formatTokens(billedInputTokens(props.usage))}</span>
          <span aria-hidden="true">·</span>
          <span title={t('stats.output')}>↓{formatTokens(props.usage.outputTokens)}</span>
          <span aria-hidden="true">·</span>
          <span title={t('stats.cache')}>{t('stats.cacheShort', { percent: cachePercent })}</span>
          {tokenTotal === undefined ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span title={t('stats.totalTokens')}>
                {t('stats.totalTokensValue', { count: formatTokens(tokenTotal) })}
              </span>
            </>
          )}
        </>
      )}
      {narrow ? props.cost?.(false, true) : props.cost?.(false)}
    </div>
  )
})

function FocusedStatsLine({
  cost,
  narrow,
  onContainer,
  counts,
  usageLabel,
  stats,
  usage,
}: {
  readonly cost?: (details: boolean, inline?: boolean) => ReactElement
  readonly narrow: boolean
  readonly onContainer: (element: HTMLDivElement | null) => void
  readonly counts: string
  readonly usageLabel: string
  readonly stats: WindowStats
  readonly usage: TokenUsage | undefined
}): ReactElement {
  const { t, locale } = useI18n()
  const [openDetail, setOpenDetail] = useState<'time' | 'tokens' | undefined>()
  return (
    <div
      ref={onContainer}
      className="dsh-stats-line dsh-stats-line--focused"
      role="group"
      aria-label={t('stats.aria')}
    >
      <StatsPopover
        label={counts}
        labelSuffix={narrow && usage === undefined ? cost?.(false, true) : undefined}
        icon="clock"
        rows={statisticsRows(stats, undefined, t, locale, 'time')}
        open={openDetail === 'time'}
        onOpenChange={(open) => setOpenDetail(open ? 'time' : undefined)}
      >
        {narrow && usage === undefined ? cost?.(true) : null}
      </StatsPopover>
      {usage === undefined ? null : (
        <StatsPopover
          label={usageLabel}
          labelSuffix={narrow ? cost?.(false, true) : undefined}
          icon="box"
          rows={statisticsRows(stats, usage, t, locale, 'tokens')}
          open={openDetail === 'tokens'}
          onOpenChange={(open) => setOpenDetail(open ? 'tokens' : undefined)}
        >
          {narrow ? cost?.(true) : null}
        </StatsPopover>
      )}
      {narrow ? null : cost?.(false)}
    </div>
  )
}

function createStatsProjector(): (
  nodes: readonly TimelineNode[],
  nodeChangeStart?: number,
  nodeChangeBase?: readonly TimelineNode[],
) => WindowStats {
  let previous: StatsCache | undefined
  return (nodes, nodeChangeStart, nodeChangeBase) => {
    const previousCache = previous
    if (previousCache?.sourceNodes === nodes) return previousCache.stats

    const commonPrefix =
      previousCache === undefined
        ? 0
        : nodeChangeStart === undefined || nodeChangeBase !== previousCache.sourceNodes
          ? commonNodePrefixLength(previousCache.sourceNodes, nodes)
          : Math.max(0, Math.min(previousCache.sourceNodes.length, nodes.length, nodeChangeStart))
    const cumulative = previousCache?.cumulative ?? []
    cumulative.length = commonPrefix
    let aggregate = cumulative[commonPrefix - 1] ?? EMPTY_NODE_STATS
    for (let index = commonPrefix; index < nodes.length; index += 1) {
      const node = nodes[index]
      if (node !== undefined) aggregate = addNodeStats(aggregate, statsForNode(node))
      cumulative.push(aggregate)
    }

    const stats = toWindowStats(aggregate)
    previous = { sourceNodes: nodes, cumulative, stats }
    return stats
  }
}

interface StatsCache {
  readonly sourceNodes: readonly TimelineNode[]
  readonly cumulative: NodeStats[]
  readonly stats: WindowStats
}

function commonNodePrefixLength(previous: readonly TimelineNode[], next: readonly TimelineNode[]): number {
  const length = Math.min(previous.length, next.length)
  let index = 0
  while (index < length && previous[index] === next[index]) index += 1
  return index
}

function addNodeStats(left: NodeStats, right: NodeStats): NodeStats {
  return {
    turns: left.turns + right.turns,
    assistantSteps: left.assistantSteps + right.assistantSteps,
    toolSteps: left.toolSteps + right.toolSteps,
    llmMs: left.llmMs + right.llmMs,
    toolMs: left.toolMs + right.toolMs,
    ttftMs: left.ttftMs + right.ttftMs,
    ttftSteps: left.ttftSteps + right.ttftSteps,
    decodeMs: left.decodeMs + right.decodeMs,
    decodeTokens: left.decodeTokens + right.decodeTokens,
  }
}

function toWindowStats(aggregate: NodeStats): WindowStats {
  // A fully represented DSH step has an assistant node. Keep the old tool-only
  // fallback for partial histories that contain a call but no assistant node;
  // a live sessionStats projection supersedes this fallback whenever present.
  return {
    turns: aggregate.turns,
    steps: aggregate.assistantSteps > 0 ? aggregate.assistantSteps : aggregate.toolSteps,
    llmMs: aggregate.llmMs,
    toolMs: aggregate.toolMs,
    ttftMs: aggregate.ttftMs,
    ttftSteps: aggregate.ttftSteps,
    decodeMs: aggregate.decodeMs,
    decodeTokens: aggregate.decodeTokens,
  }
}

function statsForNode(node: TimelineNode): NodeStats {
  const cached = nodeStatsCache.get(node)
  if (cached !== undefined) return cached

  let contribution = EMPTY_NODE_STATS
  if (node.kind === 'user-message') {
    contribution = { ...EMPTY_NODE_STATS, turns: 1 }
  } else if (node.kind === 'assistant-message') {
    let llmMs = 0
    let ttftMs = 0
    let ttftSteps = 0
    let decodeMs = 0
    let decodeTokens = 0
    const timing = node.timing
    if (timing?.stepStartTime !== null && timing?.stepStartTime !== undefined) {
      if (timing.completedTime !== null && timing.completedTime !== undefined)
        llmMs = Math.max(0, timing.completedTime - timing.stepStartTime)
      if (timing.firstTokenTime !== null && timing.firstTokenTime !== undefined) {
        ttftMs = Math.max(0, timing.firstTokenTime - timing.stepStartTime)
        ttftSteps = 1
        if (timing.completedTime !== null && timing.completedTime !== undefined && node.usage !== undefined) {
          decodeMs = Math.max(0, timing.completedTime - timing.firstTokenTime)
          decodeTokens = node.usage.outputTokens
        }
      }
    }
    contribution = {
      ...EMPTY_NODE_STATS,
      assistantSteps: 1,
      llmMs,
      ttftMs,
      ttftSteps,
      decodeMs,
      decodeTokens,
    }
  } else if (node.kind === 'tool') {
    const startedAt = parseTime(node.tool.startedAt)
    const completedAt = parseTime(node.tool.completedAt)
    contribution = {
      ...EMPTY_NODE_STATS,
      toolSteps: 1,
      toolMs: startedAt !== undefined && completedAt !== undefined ? Math.max(0, completedAt - startedAt) : 0,
    }
  }
  nodeStatsCache.set(node, contribution)
  return contribution
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function formatDuration(milliseconds: number): string {
  const seconds = milliseconds / 1_000
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

function formatRate(tokensPerSecond: number): string {
  if (tokensPerSecond >= 1_000) return `${(tokensPerSecond / 1_000).toFixed(1)}K`
  if (tokensPerSecond >= 100) return `${Math.round(tokensPerSecond)}`
  return `${Math.round(tokensPerSecond * 10) / 10}`
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return `${value}`
}
