import type { TokenUsage } from '@dsh-vscode/domain'

import type { TimelineNode } from './nodes.js'

/**
 * Turn-aware event ledger projection, mirroring the official Web UI's
 * Trajectory view: a flat record list where user records open numbered turns,
 * a standalone compaction lands in its own "Between turns" section, and the
 * main ledger keeps only index, kind, and content. Full input/output/thinking
 * payloads, per-record usage, and timing live on the record for the local
 * inspector that opens on selection.
 *
 * Contract reference (ui-trajectory README, pinned upstream): record kinds are
 * a closed set; running rows never fabricate a duration.
 */

/** Closed set of trajectory record kinds, matching the upstream ledger. */
export type TrajectoryRecordKind = 'user' | 'context' | 'compacted' | 'message' | 'tool'

export interface TrajectoryRecord {
  /** Stable identity surviving prepend of older projected records. */
  readonly id: string
  /** 1-based record index shown as `#N`, continuous across sections. */
  readonly index: number
  readonly kind: TrajectoryRecordKind
  /** Single-line non-Markdown summary; consumers ellipsize overflow. */
  readonly text: string
  /** Whether a user record opens a new model turn. */
  readonly opensTurn: boolean
  /** Own duration in seconds, or null while running / unknown. */
  readonly timeSeconds: number | null
  /** Unix epoch milliseconds when the operation started, when known. */
  readonly startedAt?: number
  /** Full input content for the inspector. */
  readonly inputDetail?: string
  /** Full output content for the inspector. */
  readonly outputDetail?: string
  /** Full reasoning content for the inspector. */
  readonly thinkingDetail?: string
  /** Assistant-only token accounting for the inspector. */
  readonly usage?: TokenUsage
  readonly modelLabel?: string
  /** Tool-only result failure state. */
  readonly isError: boolean
  /** Live rows render their running state instead of a duration. */
  readonly streaming: boolean
}

export type TrajectorySection =
  | { readonly kind: 'turn'; readonly turn: number; readonly records: readonly TrajectoryRecord[] }
  | {
      readonly kind: 'between-turns'
      readonly records: readonly TrajectoryRecord[]
    }

export interface TrajectoryProjection {
  readonly sections: readonly TrajectorySection[]
  readonly recordCount: number
}

/** DSH reserves source.kind === "user" for a direct user turn. */
function opensTurn(node: Extract<TimelineNode, { kind: 'user-message' }>): boolean {
  const source = node.source?.trim().toLowerCase()
  return source === undefined || source === 'user'
}

function singleLine(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length === 0 ? '(empty)' : flat
}

function toEpochMillis(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const millis = Date.parse(value)
  return Number.isFinite(millis) ? millis : undefined
}

function toolDurationSeconds(startedAt: string | undefined, completedAt: string | undefined): number | null {
  if (startedAt === undefined || completedAt === undefined) return null
  const start = Date.parse(startedAt)
  const end = Date.parse(completedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return (end - start) / 1000
}

/** Own assistant wall time from DSH's step/start to assistant/message. */
function assistantDurationSeconds(
  completedAt: number | undefined,
  startedAt: number | undefined,
): number | null {
  if (completedAt === undefined || startedAt === undefined) return null
  if (!Number.isFinite(completedAt) || !Number.isFinite(startedAt)) return null
  return Math.max(0, (completedAt - startedAt) / 1_000)
}

function usageNumbers(usage: TokenUsage | undefined): TokenUsage | undefined {
  if (usage === undefined) return undefined
  if (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheReadTokens === 0 &&
    usage.cacheWriteTokens === 0 &&
    usage.reasoningTokens === 0
  )
    return undefined
  return usage
}

function toolText(node: Extract<TimelineNode, { kind: 'tool' }>): string {
  const title = node.tool.title.trim()
  return title.length === 0 ? node.tool.name : title
}

/**
 * Fold timeline nodes into the Trajectory ledger. Records keep arrival order;
 * each user record opens the next numbered turn, compaction records break the
 * ledger into a standalone "Between turns" section, and node kinds outside the
 * upstream closed record set (goals, todos, notices, retries, jobs, subagents,
 * raw events) stay in the chat conversation instead.
 */
export function buildTrajectory(nodes: readonly TimelineNode[]): TrajectoryProjection {
  const sections: TrajectorySection[] = []
  let turn: number | undefined = undefined
  let turnRecords: TrajectoryRecord[] = []
  // A context event can precede the first direct user event in a hydrated
  // history (for example, a plugin snapshot restored before the first prompt).
  // Keep it pending until a real turn exists; emitting a synthetic turn 0 is
  // not part of the upstream Trajectory contract.
  let pendingContextRecords: TrajectoryRecord[] = []
  let betweenRecords: TrajectoryRecord[] | undefined = undefined
  let index = 0

  const beginTurn = (): void => {
    if (turn !== undefined) return
    turn = 1
    if (pendingContextRecords.length > 0) {
      turnRecords.push(...pendingContextRecords)
      pendingContextRecords = []
    }
  }

  const appendTurnRecord = (record: Omit<TrajectoryRecord, 'index'>): void => {
    beginTurn()
    if (betweenRecords !== undefined) {
      sections.push({ kind: 'between-turns', records: betweenRecords })
      betweenRecords = undefined
    }
    turnRecords.push({ ...record, index: ++index })
  }

  const appendBetweenRecord = (record: Omit<TrajectoryRecord, 'index'>): void => {
    if (betweenRecords === undefined) betweenRecords = []
    betweenRecords.push({ ...record, index: ++index })
  }

  for (const node of nodes) {
    switch (node.kind) {
      case 'user-message': {
        if (opensTurn(node)) {
          if (turn === undefined) {
            beginTurn()
          } else if (turnRecords.length > 0) {
            const currentTurn: number = turn
            sections.push({ kind: 'turn', turn: currentTurn, records: turnRecords })
            turnRecords = []
            turn = currentTurn + 1
          }
          appendTurnRecord({
            id: `user\u0000${node.id}`,
            kind: 'user',
            text: singleLine(node.markdown),
            opensTurn: true,
            timeSeconds: null,
            inputDetail: node.markdown,
            isError: false,
            streaming: false,
            ...(node.sourceSummary === undefined ? {} : { modelLabel: node.sourceSummary }),
          })
        } else {
          const contextRecord: Omit<TrajectoryRecord, 'index'> = {
            id: `context\u0000${node.id}`,
            kind: 'context',
            text: singleLine(node.markdown),
            opensTurn: false,
            timeSeconds: null,
            inputDetail: node.markdown,
            isError: false,
            streaming: false,
            ...(node.source === undefined ? {} : { modelLabel: node.source }),
          }
          if (turn === undefined) pendingContextRecords.push({ ...contextRecord, index: ++index })
          else appendTurnRecord(contextRecord)
        }
        break
      }
      case 'assistant-message': {
        const startedAt = node.timing?.stepStartTime ?? undefined
        const completedAt = node.timing?.completedTime ?? undefined
        appendTurnRecord({
          id: `message\u0000${node.id}`,
          kind: 'message',
          text: singleLine(node.markdown),
          opensTurn: false,
          timeSeconds: node.streaming ? null : assistantDurationSeconds(completedAt, startedAt),
          ...(startedAt === undefined ? {} : { startedAt }),
          outputDetail: node.markdown,
          isError: false,
          streaming: node.streaming,
          ...(node.modelLabel === undefined ? {} : { modelLabel: node.modelLabel }),
          ...(node.reasoning === undefined ? {} : { thinkingDetail: node.reasoning.markdown }),
          ...(usageNumbers(node.usage) === undefined ? {} : { usage: node.usage }),
        })
        break
      }
      case 'reasoning': {
        appendTurnRecord({
          id: `message\u0000${node.id}`,
          kind: 'message',
          text: singleLine(node.markdown),
          opensTurn: false,
          timeSeconds: null,
          thinkingDetail: node.markdown,
          isError: false,
          streaming: node.streaming,
        })
        break
      }
      case 'tool': {
        const running = node.tool.status === 'queued' || node.tool.status === 'running'
        const startedAt = toEpochMillis(node.tool.startedAt)
        appendTurnRecord({
          id: `tool\u0000${node.id}`,
          kind: 'tool',
          text: toolText(node),
          opensTurn: false,
          timeSeconds: running ? null : toolDurationSeconds(node.tool.startedAt, node.tool.completedAt),
          ...(startedAt === undefined ? {} : { startedAt }),
          ...(node.tool.inputSummary === undefined ? {} : { inputDetail: node.tool.inputSummary }),
          ...(node.tool.outputSummary === undefined ? {} : { outputDetail: node.tool.outputSummary }),
          isError: node.tool.status === 'failed',
          streaming: running,
        })
        break
      }
      case 'compaction': {
        appendBetweenRecord({
          id: `compacted\u0000${node.id}`,
          kind: 'compacted',
          text: compactionText(node),
          opensTurn: false,
          timeSeconds: null,
          ...(node.compaction.summary === undefined ? {} : { outputDetail: node.compaction.summary }),
          isError: false,
          streaming: node.compaction.phase !== 'end',
        })
        break
      }
      default:
        break
    }
  }

  if (betweenRecords !== undefined) sections.push({ kind: 'between-turns', records: betweenRecords })
  if (turnRecords.length > 0) sections.push({ kind: 'turn', turn: turn ?? 1, records: turnRecords })
  if (pendingContextRecords.length > 0)
    sections.push({ kind: 'turn', turn: turn ?? 1, records: pendingContextRecords })

  return { sections, recordCount: index }
}

function compactionText(node: Extract<TimelineNode, { kind: 'compaction' }>): string {
  const parts: string[] = [`compaction ${node.compaction.phase}`]
  if (node.compaction.replacedCount !== undefined) parts.push(`${node.compaction.replacedCount} replaced`)
  if (node.compaction.estimatedTokens !== undefined) parts.push(`~${node.compaction.estimatedTokens} tokens`)
  return parts.join(' · ')
}

/**
 * Case-insensitive substring search across the loaded ledger window, matching
 * the official Trajectory toolbar search: summaries and inspector payloads
 * (input, output, thinking) are all searchable.
 */
export function searchTrajectoryRecords(
  projection: TrajectoryProjection,
  query: string,
): readonly TrajectoryRecord[] {
  const needle = query.trim().toLowerCase()
  const matches: TrajectoryRecord[] = []
  if (needle === '') return matches
  for (const section of projection.sections) {
    for (const record of section.records) {
      const haystack = [record.text, record.inputDetail, record.outputDetail, record.thinkingDetail]
        .filter((value): value is string => value !== undefined)
        .join('\n')
        .toLowerCase()
      if (haystack.includes(needle)) matches.push(record)
    }
  }
  return matches
}
