import type {
  JobView,
  PermissionRequest,
  SessionSummary,
  SubagentCatalog,
  SubagentLiveActivity,
  SubagentView,
  UserQuestion,
} from '@dsh-vscode/domain'
import { toolNameLabel } from '@dsh-vscode/ui'
import type { Translate } from '../../i18n.js'

export interface CatalogNode {
  readonly entry: SubagentCatalog['entries'][number]
  readonly level: number
  readonly parentAvailable: boolean
}

export interface SubagentAggregate {
  readonly total: number
  readonly running: number
}

export type SubagentDotState = 'ongoing' | 'warning' | 'done' | 'error'

export function isSubagentRunning(entry: SubagentView): boolean {
  return entry.activity === 'running'
}

export function childEntries(catalog: SubagentCatalog): readonly SubagentView[] {
  return catalog.entries.filter((entry): entry is SubagentView => entry.kind === 'child')
}

export function subagentDisplayLabel(entry: SubagentView, t: Translate): string {
  return [entry.name, entry.label?.trim()].filter(Boolean).join(' · ') || entry.id || t('subagents.unnamed')
}

export function subagentModeLabel(mode: SubagentView['mode'], t: Translate): string {
  if (mode === 'external') return t('subagents.mode.external')
  if (mode === 'continuable') return t('subagents.mode.continuable')
  return t('subagents.mode.oneShot')
}

export function subagentNeedsAttention(
  entry: SubagentView,
  activity: SubagentLiveActivity | undefined,
  permissions?: readonly PermissionRequest[],
  questions?: readonly UserQuestion[],
): 'approval' | 'question' | undefined {
  if (
    activity?.phase === 'awaiting-approval' ||
    permissions?.some((request) => request.sessionId === entry.id) === true
  )
    return 'approval'
  if (
    activity?.phase === 'awaiting-question' ||
    questions?.some((question) => question.sessionId === entry.id) === true
  )
    return 'question'
  return undefined
}

export function subagentDotState(
  entry: SubagentView,
  activity: SubagentLiveActivity | undefined,
  permissions?: readonly PermissionRequest[],
  questions?: readonly UserQuestion[],
): SubagentDotState {
  if (subagentNeedsAttention(entry, activity, permissions, questions) !== undefined) return 'warning'
  return isSubagentRunning(entry) ? 'ongoing' : 'done'
}

function matchingSubagentJobProgress(entry: SubagentView, jobs?: readonly JobView[]): string | undefined {
  if (jobs === undefined || jobs.length === 0) return undefined
  for (const job of jobs) {
    if (job.id !== entry.id) continue
    if (job.status !== 'running' && job.status !== 'stopping') continue
    if (job.kind !== 'subagent' && !job.kind.startsWith('subagent-')) continue
    const progress = job.progress?.trim()
    if (progress === undefined || progress === '') continue
    return progress
  }
  return undefined
}

/**
 * Concise, localized live activity heading for one subagent row.
 * Uses strictly structured Host activity, pending interactions, or DSH job progress.
 */
export function subagentActivityHeading(
  entry: SubagentView,
  activity: SubagentLiveActivity | undefined,
  t: Translate,
  options: {
    readonly jobs?: readonly JobView[]
    readonly permissions?: readonly PermissionRequest[]
    readonly questions?: readonly UserQuestion[]
  } = {},
): string {
  const attention = subagentNeedsAttention(entry, activity, options.permissions, options.questions)
  if (attention === 'approval') return t('subagents.live.awaitingApproval')
  if (attention === 'question') return t('subagents.live.awaitingQuestion')

  if (entry.activity !== 'running') return t('subagents.activity.inactive')

  if (activity !== undefined) {
    if (activity.phase === 'tool') {
      const toolLabel =
        activity.toolName === undefined
          ? undefined
          : (toolNameLabel(activity.toolName, t) ?? activity.toolName)
      if (toolLabel !== undefined && toolLabel !== '') {
        return activity.activeToolCount !== undefined && activity.activeToolCount > 1
          ? t('subagents.live.runningTools', { tool: toolLabel, count: activity.activeToolCount })
          : t('subagents.live.runningTool', { tool: toolLabel })
      }
      return t('subagents.live.runningGenericTool')
    }
    if (activity.phase === 'preparing-tool') {
      const toolLabel =
        activity.toolName === undefined
          ? undefined
          : (toolNameLabel(activity.toolName, t) ?? activity.toolName)
      return toolLabel !== undefined && toolLabel !== ''
        ? t('subagents.live.preparingTool', { tool: toolLabel })
        : t('subagents.live.preparingGenericTool')
    }
    if (activity.phase === 'thinking') return t('subagents.live.thinking')
    if (activity.phase === 'responding') return t('subagents.live.responding')
  }

  const jobProgress = matchingSubagentJobProgress(entry, options.jobs)
  if (jobProgress !== undefined) return jobProgress

  return t('subagents.activity.running')
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function formatTokens(value: number): string {
  const scaled = (next: number): string =>
    next >= 100 ? String(Math.round(next)) : String(Math.round(next * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`
  return `${scaled(value / 1_000_000)}M`
}

export function subagentTokenTotal(summary: SessionSummary | undefined): number | undefined {
  const usage = record(summary?.projection?.values.tokenUsage)
  if (usage === undefined) return undefined
  const input = nonNegativeInteger(usage.uncachedInputTokens ?? usage.inputTokens)
  const output = nonNegativeInteger(usage.outputTokens)
  const cacheRead = nonNegativeInteger(usage.cacheReadTokens)
  const cacheWrite = nonNegativeInteger(usage.cacheWriteTokens)
  if (
    input === undefined ||
    output === undefined ||
    (usage.cacheReadTokens !== undefined && cacheRead === undefined) ||
    (usage.cacheWriteTokens !== undefined && cacheWrite === undefined)
  )
    return undefined
  return (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
}

export function subagentDurationMs(
  summary: SessionSummary | undefined,
  activity: SubagentView['activity'],
  now: number,
): number | undefined {
  const timing = record(summary?.projection?.values.subagentTiming)
  if (timing === undefined) return undefined
  const settledMs = nonNegativeInteger(timing.settledMs)
  if (settledMs === undefined) return undefined
  if (timing.active === undefined) return settledMs
  const active = record(timing.active)
  if (active === undefined) return undefined
  const since = nonNegativeInteger(active.since)
  const through = nonNegativeInteger(active.through)
  if (since === undefined || through === undefined) return undefined
  const end = activity === 'running' ? now : through
  return settledMs + Math.max(0, end - since)
}

export function formatSubagentDuration(ms: number, t: Translate): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return t('duration.hoursMinutes', { hours, minutes: String(minutes % 60).padStart(2, '0') })
  if (minutes > 0)
    return t('duration.minutesSeconds', { minutes, seconds: String(totalSeconds % 60).padStart(2, '0') })
  return t('duration.seconds', { seconds: totalSeconds })
}

export function aggregateLoadedChildren(
  catalog: SubagentCatalog,
  catalogs: Readonly<Record<string, SubagentCatalog>>,
  visited: ReadonlySet<string> = new Set(),
): SubagentAggregate {
  let total = 0
  let running = 0
  for (const entry of childEntries(catalog)) {
    total += 1
    if (isSubagentRunning(entry)) running += 1
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

export function flattenSubagentCatalog(
  catalog: SubagentCatalog,
  catalogs: Readonly<Record<string, SubagentCatalog>>,
  expanded: ReadonlySet<string>,
  level: number,
  output: CatalogNode[] = [],
  visited: ReadonlySet<string> = new Set(),
): CatalogNode[] {
  for (const entry of catalog.entries) {
    output.push({ entry, level, parentAvailable: catalog.parentAvailable })
    if (entry.kind === 'child' && entry.hasChildren && expanded.has(entry.id) && !visited.has(entry.id)) {
      const branch = catalogs[entry.id]
      if (branch !== undefined) {
        const nextVisited = new Set(visited)
        nextVisited.add(entry.id)
        flattenSubagentCatalog(branch, catalogs, expanded, level + 1, output, nextVisited)
      }
    }
  }
  return output
}
