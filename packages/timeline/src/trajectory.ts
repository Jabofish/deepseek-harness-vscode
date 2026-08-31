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

const TRAJECTORY_SUMMARY_MAX_LENGTH = 240

/** DSH reserves source.kind === "user" for a direct user turn. */
function opensTurn(node: Extract<TimelineNode, { kind: 'user-message' }>): boolean {
  const source = node.source?.trim().toLowerCase()
  return source === undefined || source === 'user'
}

function singleLine(value: string): string {
  let summary = ''
  let pendingSpace = false
  for (const character of value) {
    if (/\s/u.test(character)) {
      if (summary !== '') pendingSpace = true
      continue
    }
    if (pendingSpace) {
      summary += ' '
      pendingSpace = false
    }
    summary += character
    if (summary.length >= TRAJECTORY_SUMMARY_MAX_LENGTH) {
      return `${summary.slice(0, TRAJECTORY_SUMMARY_MAX_LENGTH - 1)}…`
    }
  }
  return summary === '' ? '(empty)' : summary
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

type TrajectoryRecordData = Omit<TrajectoryRecord, 'index'>

/**
 * Timeline nodes are immutable snapshots. Keep the expensive text/timestamp
 * projection attached to the snapshot so a streaming update only has to
 * project the node that actually changed; the fold below still rebuilds the
 * section/index shape to preserve its pure public API.
 */
const trajectoryRecordCache = new WeakMap<TimelineNode, TrajectoryRecordData | undefined>()
const indexedTrajectoryRecordCache = new WeakMap<TrajectoryRecordData, Map<number, TrajectoryRecord>>()
const trajectorySearchTextCache = new WeakMap<TrajectoryRecord, string>()
const EMPTY_TRAJECTORY_RECORDS: readonly TrajectoryRecord[] = []

function trajectoryRecordForNode(node: TimelineNode): TrajectoryRecordData | undefined {
  if (trajectoryRecordCache.has(node)) return trajectoryRecordCache.get(node)

  let record: TrajectoryRecordData | undefined
  switch (node.kind) {
    case 'user-message':
      record = opensTurn(node)
        ? {
            id: `user\u0000${node.id}`,
            kind: 'user',
            text: singleLine(node.markdown),
            opensTurn: true,
            timeSeconds: null,
            inputDetail: node.markdown,
            isError: false,
            streaming: false,
            ...(node.sourceSummary === undefined ? {} : { modelLabel: node.sourceSummary }),
          }
        : {
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
      break
    case 'assistant-message': {
      const startedAt = node.timing?.stepStartTime ?? undefined
      const completedAt = node.timing?.completedTime ?? undefined
      const usage = usageNumbers(node.usage)
      record = {
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
        ...(usage === undefined ? {} : { usage }),
      }
      break
    }
    case 'reasoning':
      record = {
        id: `message\u0000${node.id}`,
        kind: 'message',
        text: singleLine(node.markdown),
        opensTurn: false,
        timeSeconds: null,
        thinkingDetail: node.markdown,
        isError: false,
        streaming: node.streaming,
      }
      break
    case 'tool': {
      const running = node.tool.status === 'queued' || node.tool.status === 'running'
      const startedAt = toEpochMillis(node.tool.startedAt)
      record = {
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
      }
      break
    }
    case 'compaction':
      record = {
        id: `compacted\u0000${node.id}`,
        kind: 'compacted',
        text: compactionText(node),
        opensTurn: false,
        timeSeconds: null,
        ...(node.compaction.summary === undefined ? {} : { outputDetail: node.compaction.summary }),
        isError: false,
        streaming: node.compaction.phase !== 'end',
      }
      break
    default:
      record = undefined
      break
  }

  trajectoryRecordCache.set(node, record)
  return record
}

function indexedTrajectoryRecord(record: TrajectoryRecordData, index: number): TrajectoryRecord {
  let byIndex = indexedTrajectoryRecordCache.get(record)
  if (byIndex === undefined) {
    byIndex = new Map<number, TrajectoryRecord>()
    indexedTrajectoryRecordCache.set(record, byIndex)
  }
  const cached = byIndex.get(index)
  if (cached !== undefined) return cached
  const indexed = { ...record, index }
  byIndex.set(index, indexed)
  return indexed
}

interface MutableTrajectoryFold {
  sections: TrajectorySection[]
  turn: number | undefined
  turnRecords: TrajectoryRecord[]
  pendingContextRecords: TrajectoryRecord[]
  betweenRecords: TrajectoryRecord[] | undefined
  index: number
}

interface TrajectoryFoldCheckpoint {
  readonly sections: readonly TrajectorySection[]
  readonly turn: number | undefined
  readonly turnRecords: readonly TrajectoryRecord[]
  readonly pendingContextRecords: readonly TrajectoryRecord[]
  readonly betweenRecords: readonly TrajectoryRecord[] | undefined
  readonly index: number
}

interface FoldTrajectoryResult {
  readonly projection: TrajectoryProjection
  readonly checkpoint?: TrajectoryFoldCheckpoint
}

interface TrajectoryProjectionCache {
  readonly sourceNodes: readonly TimelineNode[]
  readonly stableRawLength: number
  readonly checkpoint: TrajectoryFoldCheckpoint
  readonly projection: TrajectoryProjection
}

const EMPTY_TRAJECTORY_CHECKPOINT: TrajectoryFoldCheckpoint = {
  sections: [],
  turn: undefined,
  turnRecords: [],
  pendingContextRecords: [],
  betweenRecords: undefined,
  index: 0,
}

function snapshotTrajectoryFold(fold: MutableTrajectoryFold): TrajectoryFoldCheckpoint {
  return {
    sections: fold.sections.slice(),
    turn: fold.turn,
    turnRecords: fold.turnRecords.slice(),
    pendingContextRecords: fold.pendingContextRecords.slice(),
    betweenRecords: fold.betweenRecords?.slice(),
    index: fold.index,
  }
}

function foldTrajectoryNodes(
  nodes: readonly TimelineNode[],
  start: number,
  checkpoint: TrajectoryFoldCheckpoint,
  captureAt?: number,
): FoldTrajectoryResult {
  const fold: MutableTrajectoryFold = {
    sections: [...checkpoint.sections],
    turn: checkpoint.turn,
    turnRecords: [...checkpoint.turnRecords],
    pendingContextRecords: [...checkpoint.pendingContextRecords],
    betweenRecords: checkpoint.betweenRecords === undefined ? undefined : [...checkpoint.betweenRecords],
    index: checkpoint.index,
  }
  let capturedCheckpoint: TrajectoryFoldCheckpoint | undefined =
    captureAt === start ? snapshotTrajectoryFold(fold) : undefined

  const beginTurn = (): void => {
    if (fold.turn !== undefined) return
    fold.turn = 1
    if (fold.pendingContextRecords.length > 0) {
      fold.turnRecords.push(...fold.pendingContextRecords)
      fold.pendingContextRecords = []
    }
  }

  const appendTurnRecord = (record: TrajectoryRecordData): void => {
    beginTurn()
    if (fold.betweenRecords !== undefined) {
      fold.sections.push({ kind: 'between-turns', records: fold.betweenRecords })
      fold.betweenRecords = undefined
    }
    fold.turnRecords.push(indexedTrajectoryRecord(record, ++fold.index))
  }

  const appendBetweenRecord = (record: TrajectoryRecordData): void => {
    if (fold.betweenRecords === undefined) fold.betweenRecords = []
    fold.betweenRecords.push(indexedTrajectoryRecord(record, ++fold.index))
  }

  for (let rawIndex = start; rawIndex < nodes.length; rawIndex += 1) {
    const node = nodes[rawIndex]
    if (node === undefined) continue
    const record = trajectoryRecordForNode(node)
    if (record !== undefined) {
      if (node.kind === 'user-message') {
        if (record.kind === 'user') {
          if (fold.turn === undefined) beginTurn()
          else if (fold.turnRecords.length > 0) {
            const currentTurn: number = fold.turn
            fold.sections.push({ kind: 'turn', turn: currentTurn, records: fold.turnRecords })
            fold.turnRecords = []
            fold.turn = currentTurn + 1
          }
          appendTurnRecord(record)
        } else if (fold.turn === undefined) {
          fold.pendingContextRecords.push(indexedTrajectoryRecord(record, ++fold.index))
        } else appendTurnRecord(record)
      } else if (record.kind === 'compacted') {
        appendBetweenRecord(record)
      } else {
        appendTurnRecord(record)
      }
    }

    if (captureAt !== undefined && rawIndex + 1 === captureAt) {
      capturedCheckpoint = snapshotTrajectoryFold(fold)
    }
  }

  if (fold.betweenRecords !== undefined)
    fold.sections.push({ kind: 'between-turns', records: fold.betweenRecords })
  if (fold.turnRecords.length > 0)
    fold.sections.push({ kind: 'turn', turn: fold.turn ?? 1, records: fold.turnRecords })
  if (fold.pendingContextRecords.length > 0)
    fold.sections.push({ kind: 'turn', turn: fold.turn ?? 1, records: fold.pendingContextRecords })

  return {
    projection: { sections: fold.sections, recordCount: fold.index },
    ...(capturedCheckpoint === undefined ? {} : { checkpoint: capturedCheckpoint }),
  }
}

function isTrajectoryBoundary(node: TimelineNode | undefined): boolean {
  if (node === undefined) return false
  if (node.kind === 'assistant-message' || node.kind === 'reasoning') return !node.streaming
  if (node.kind === 'tool') return node.tool.status !== 'queued' && node.tool.status !== 'running'
  if (node.kind === 'compaction') return node.compaction.phase === 'end'
  return true
}

function latestTrajectoryBoundary(nodes: readonly TimelineNode[], start: number): number {
  for (let index = nodes.length - 1; index >= start; index -= 1) {
    if (isTrajectoryBoundary(nodes[index])) return index + 1
  }
  return start
}

function commonTrajectoryNodePrefixLength(
  previous: readonly TimelineNode[],
  next: readonly TimelineNode[],
): number {
  const limit = Math.min(previous.length, next.length)
  let index = 0
  while (index < limit && previous[index] === next[index]) index += 1
  return index
}

/**
 * Fold timeline nodes into the Trajectory ledger. Records keep arrival order;
 * each user record opens the next numbered turn, compaction records break the
 * ledger into a standalone "Between turns" section, and node kinds outside the
 * upstream closed record set (goals, todos, notices, retries, jobs, subagents,
 * raw events) stay in the chat conversation instead.
 */
export function buildTrajectory(nodes: readonly TimelineNode[]): TrajectoryProjection {
  return foldTrajectoryNodes(nodes, 0, EMPTY_TRAJECTORY_CHECKPOINT).projection
}

/**
 * Create a stateful Trajectory projector for immutable Timeline snapshots.
 * Stable prefixes end at the last non-streaming work boundary, so repeated
 * assistant/tool/reasoning updates only fold the active suffix while retaining
 * the exact output of buildTrajectory().
 */
export function createTrajectoryProjector(): (
  nodes: readonly TimelineNode[],
  nodeChangeStart?: number,
  nodeChangeBase?: readonly TimelineNode[],
) => TrajectoryProjection {
  let previous: TrajectoryProjectionCache | undefined

  return (nodes, nodeChangeStart, nodeChangeBase) => {
    const previousCache = previous
    if (previousCache?.sourceNodes === nodes) return previousCache.projection

    const commonPrefix =
      previousCache === undefined
        ? 0
        : nodeChangeStart === undefined || nodeChangeBase !== previousCache.sourceNodes
          ? commonTrajectoryNodePrefixLength(previousCache.sourceNodes, nodes)
          : Math.max(0, Math.min(nodeChangeStart, previousCache.sourceNodes.length, nodes.length))
    const canReuseCheckpoint =
      previousCache !== undefined &&
      commonPrefix >= previousCache.stableRawLength &&
      nodes.length >= previousCache.stableRawLength
    const start = canReuseCheckpoint ? previousCache.stableRawLength : 0
    const checkpoint = canReuseCheckpoint ? previousCache.checkpoint : EMPTY_TRAJECTORY_CHECKPOINT
    const stableRawLength = latestTrajectoryBoundary(nodes, start)
    const folded = foldTrajectoryNodes(nodes, start, checkpoint, stableRawLength)
    const next: TrajectoryProjectionCache = {
      sourceNodes: nodes,
      stableRawLength,
      checkpoint: folded.checkpoint ?? EMPTY_TRAJECTORY_CHECKPOINT,
      projection: folded.projection,
    }
    previous = next
    return next.projection
  }
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
  if (needle === '') return EMPTY_TRAJECTORY_RECORDS
  const matches: TrajectoryRecord[] = []
  for (const section of projection.sections) {
    for (const record of section.records) {
      let haystack = trajectorySearchTextCache.get(record)
      if (haystack === undefined) {
        haystack = [record.text, record.inputDetail, record.outputDetail, record.thinkingDetail]
          .filter((value): value is string => value !== undefined)
          .join('\n')
          .toLowerCase()
        trajectorySearchTextCache.set(record, haystack)
      }
      if (haystack.includes(needle)) matches.push(record)
    }
  }
  return matches
}
