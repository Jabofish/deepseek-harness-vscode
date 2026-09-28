import type { AssistantTiming, TimelineNode } from '@dsh-vscode/timeline'
import type { TokenUsage } from '@dsh-vscode/domain'

import type { Translate } from '../../i18n.js'
import {
  type AssistantTurnNode,
  type DisplayTimelineNode,
  type ExpandedDetailsSetter,
} from './timeline-shared.js'

export function formatExactTokens(value: number): string {
  return value.toLocaleString()
}
export function assistantNodeInProgress(
  node:
    | Pick<AssistantTurnNode, 'streaming' | 'reasoning' | 'tools' | 'turn'>
    | Extract<DisplayTimelineNode, { readonly kind: 'assistant-message' }>,
): boolean {
  return (
    node.streaming ||
    node.reasoning?.streaming === true ||
    ('tools' in node &&
      node.tools.some((tool) => tool.tool.status === 'queued' || tool.tool.status === 'running'))
  )
}

const reasoningExpandedChangeCache = new WeakMap<
  ExpandedDetailsSetter,
  Map<string, (expanded: boolean) => void>
>()

export function reasoningExpandedChange(
  setExpanded: ExpandedDetailsSetter,
  id: string,
): (expanded: boolean) => void {
  let callbacks = reasoningExpandedChangeCache.get(setExpanded)
  if (callbacks === undefined) {
    callbacks = new Map()
    reasoningExpandedChangeCache.set(setExpanded, callbacks)
  }
  const cached = callbacks.get(id)
  if (cached !== undefined) return cached
  const callback = (nextExpanded: boolean): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (nextExpanded) next.add(id)
      else next.delete(id)
      return next
    })
  }
  callbacks.set(id, callback)
  return callback
}

export function compactionMeta(
  compaction: Extract<TimelineNode, { readonly kind: 'compaction' }>['compaction'],
  t: Translate = (key) => key,
): string {
  const parts: string[] = []
  if (compaction.replacedCount !== undefined)
    parts.push(t('timeline.compactionEntries', { count: compaction.replacedCount }))
  if (compaction.estimatedTokens !== undefined)
    parts.push(t('timeline.compactionTokens', { count: formatTokenCount(compaction.estimatedTokens) }))
  if (parts.length === 0) parts.push(compaction.phase)
  return parts.join(' · ')
}

export function turnTerminalLabel(
  reason: Extract<TimelineNode, { readonly kind: 'turn-terminal' }>['reason'],
  t: Translate,
): string {
  switch (reason) {
    case 'max-tokens':
      return t('timeline.turnMaxTokens')
    case 'error':
      return t('timeline.turnError')
    case 'blocked':
      return t('timeline.turnBlocked')
    case 'aborted':
      return t('timeline.turnAborted')
    case 'interrupted':
      return t('timeline.turnInterrupted')
    default:
      return t('timeline.turnEndedUnexpectedly')
  }
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return `${value}`
}

/**
 * Per-message hover telemetry. Every value is derived only from DSH durable
 * timing/usage fields; the Webview never starts its own stopwatch for a
 * completed message.
 */
export function assistantMetricsLabel(
  timing: AssistantTiming | undefined,
  usage: TokenUsage | undefined,
  t: Translate = (key) => key,
): string | undefined {
  if (timing === undefined) return undefined
  const parts: string[] = []
  if (timing.stepStartTime !== null && timing.firstTokenTime !== null) {
    parts.push(
      t('timeline.metrics.ttft', {
        duration: formatMetricDuration(Math.max(0, timing.firstTokenTime - timing.stepStartTime)),
      }),
    )
  }
  if (usage !== undefined && timing.firstTokenTime !== null && timing.completedTime !== null) {
    const seconds = Math.max(0, timing.completedTime - timing.firstTokenTime) / 1_000
    if (seconds > 0 && usage.outputTokens > 0)
      parts.push(
        t('timeline.metrics.rate', {
          rate: formatMetricRate(usage.outputTokens / seconds),
        }),
      )
  }
  return parts.length === 0 ? undefined : parts.join(' · ')
}

export function formatMetricDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`
  return `${Math.round((milliseconds / 1_000) * 10) / 10}s`
}

export function formatMetricRate(value: number): string {
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K tok/s`
  return `${Math.round(value * 10) / 10} tok/s`
}

export function branchUnavailableForNode(node: DisplayTimelineNode, branching: boolean): boolean {
  if (node.kind !== 'assistant-message' && node.kind !== 'assistant-turn') return true
  return (
    branching ||
    assistantNodeInProgress(node) ||
    (node.turn !== undefined && node.turnCompleted !== true) ||
    node.sequence === undefined
  )
}
