import { memo, useMemo, type ReactElement } from 'react'
import type { SessionStatsProjection, TokenUsage } from '@dsh-vscode/domain'
import { billedInputTokens, cacheHitPercent } from '@dsh-vscode/timeline'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { useI18n } from '../../i18n.js'

export interface StatsLineProps {
  readonly nodes: readonly TimelineNode[]
  /** Optional reducer boundary for incremental fallback statistics. */
  readonly nodeChangeStart?: number
  readonly nodeChangeBase?: readonly TimelineNode[]
  readonly usage: TokenUsage | undefined
  readonly cacheHit: number
  /** Whole-log DSH projection; the visible-node fold is only a fallback. */
  readonly sessionStats?: SessionStatsProjection | undefined
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
  const { t } = useI18n()
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
  const tokenTotal =
    props.usage === undefined
      ? undefined
      : props.usage.inputTokens +
        props.usage.outputTokens +
        (props.usage.cacheReadTokens ?? 0) +
        (props.usage.cacheWriteTokens ?? 0)
  const durations: string[] = []
  if (stats.llmMs > 0) durations.push(`LLM ${formatDuration(stats.llmMs)}`)
  if (stats.toolMs > 0) durations.push(`${t('stats.tool')} ${formatDuration(stats.toolMs)}`)
  const speeds: string[] = []
  if (stats.ttftSteps > 0) speeds.push(`TTFT ${formatDuration(stats.ttftMs / stats.ttftSteps)}`)
  if (stats.decodeMs > 0 && stats.decodeTokens > 0)
    speeds.push(`${formatRate(stats.decodeTokens / (stats.decodeMs / 1_000))} tk/s`)
  return (
    <div className="dsh-stats-line" role="status" aria-label={t('stats.aria')}>
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
    </div>
  )
})

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
