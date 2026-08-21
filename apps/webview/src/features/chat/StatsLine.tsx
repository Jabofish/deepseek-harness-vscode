import { useMemo, type ReactElement } from 'react'
import type { SessionStatsProjection, TokenUsage } from '@dsh-vscode/domain'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { useI18n } from '../../i18n.js'

export interface StatsLineProps {
  readonly nodes: readonly TimelineNode[]
  readonly usage: TokenUsage | undefined
  readonly cacheHit: number
  /** Whole-log DSH projection; the visible-node fold is only a fallback. */
  readonly sessionStats?: SessionStatsProjection | undefined
}

type WindowStats = SessionStatsProjection

/**
 * Sticky session statistics above the composer, mirroring the official Web
 * UI's StatsLine: counts, DSH wall-time/speed metrics, cache hit, and token
 * totals. The projection is authoritative because the visible timeline can be
 * paged or compacted.
 */
export function StatsLine(props: StatsLineProps): ReactElement {
  const { t } = useI18n()
  const stats = useMemo(
    () => props.sessionStats ?? computeStats(props.nodes),
    [props.nodes, props.sessionStats],
  )
  if (stats.turns === 0 && props.usage === undefined)
    return <div className="dsh-stats-line" aria-hidden="true" />
  const cachePercent = props.usage === undefined ? 0 : Math.round(props.cacheHit * 100)
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
          <span title={t('stats.input')}>
            ↑{formatTokens(props.usage.inputTokens + (props.usage.cacheReadTokens ?? 0))}
          </span>
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
}

function computeStats(nodes: readonly TimelineNode[]): WindowStats {
  let turns = 0
  let assistantSteps = 0
  let toolSteps = 0
  let llmMs = 0
  let toolMs = 0
  let ttftMs = 0
  let ttftSteps = 0
  let decodeMs = 0
  let decodeTokens = 0
  for (const node of nodes) {
    if (node.kind === 'user-message') {
      turns += 1
      continue
    }
    if (node.kind === 'assistant-message') {
      assistantSteps += 1
      const timing = node.timing
      if (timing?.stepStartTime !== null && timing?.stepStartTime !== undefined) {
        if (timing.completedTime !== null && timing.completedTime !== undefined)
          llmMs += Math.max(0, timing.completedTime - timing.stepStartTime)
        if (timing.firstTokenTime !== null && timing.firstTokenTime !== undefined) {
          ttftMs += Math.max(0, timing.firstTokenTime - timing.stepStartTime)
          ttftSteps += 1
          if (
            timing.completedTime !== null &&
            timing.completedTime !== undefined &&
            node.usage !== undefined
          ) {
            decodeMs += Math.max(0, timing.completedTime - timing.firstTokenTime)
            decodeTokens += node.usage.outputTokens
          }
        }
      }
      continue
    }
    if (node.kind === 'tool') {
      toolSteps += 1
      const startedAt = parseTime(node.tool.startedAt)
      const completedAt = parseTime(node.tool.completedAt)
      if (startedAt !== undefined && completedAt !== undefined) toolMs += Math.max(0, completedAt - startedAt)
    }
  }
  // A fully represented DSH step has an assistant node. Keep the old tool-only
  // fallback for partial histories that contain a call but no assistant node;
  // a live sessionStats projection supersedes this fallback whenever present.
  return {
    turns,
    steps: assistantSteps > 0 ? assistantSteps : toolSteps,
    llmMs,
    toolMs,
    ttftMs,
    ttftSteps,
    decodeMs,
    decodeTokens,
  }
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
