import {
  asRecord,
  hasExactKeys,
  isJsonLike,
  isNonEmptyString,
  isPlainRecord,
  isSafeAlphaCursor,
  isSafeAlphaSequence,
  malformedResponse,
  recordOrUndefined,
} from './remote-mux.js'
import type { AlphaSessionWireVersion } from './remote-mux.js'
import { STREAM_BATCH_SIZE, STREAM_TIME_SLICE_MS, yieldToEventLoop } from '../../stream-scheduling.js'
export { yieldToEventLoop } from '../../stream-scheduling.js'
import { validAlpha151SessionEventFrame, validAlpha151SessionSnapshot } from '../alpha151/session-wire.js'
import {
  normalizeAlpha171Event,
  readAlpha171HistoryRecord,
  readAlpha171SessionSnapshot,
  readAlpha171SessionSnapshotEnvelope,
  UNREADABLE_HISTORY_EVENT,
  type AlphaV4SessionProfile,
  validAlpha171SessionEventFrame,
  validAlpha171SessionSnapshot,
} from '../alpha171/session-wire.js'

export function alphaSessionList(value: unknown): unknown {
  const record = recordOrUndefined(value)
  if (record === undefined || !Array.isArray(record.items))
    throw new Error('session list is not an object with items')
  return {
    ...record,
    items: record.items.map((entry) => {
      const item = recordOrUndefined(entry)
      if (item === undefined || typeof item.sessionId !== 'string' || item.sessionId.trim() === '')
        throw new Error('session list item is malformed')
      if (hasDefinedAlphaTitle(item)) return item
      return {
        ...item,
        title: workspaceTitleFromPath(item.cwd) ?? item.sessionId,
      }
    }),
  }
}

function normalizeV4Event(
  event: Record<string, unknown>,
  profile?: AlphaV4SessionProfile,
): Record<string, unknown> {
  if (event.type === UNREADABLE_HISTORY_EVENT)
    return { type: 'system/message', seq: event.seq, time: event.time, data: {} }
  const normalized = normalizeAlpha171Event(event)
  return profile?.normalizeEvent?.(normalized) ?? normalized
}

function hasDefinedAlphaTitle(value: Record<string, unknown>): boolean {
  if (typeof value.title === 'string' || typeof value.name === 'string') return true
  const projections = recordOrUndefined(value.projections)
  const values = recordOrUndefined(projections?.values)
  return typeof values?.title === 'string'
}

export function normalizeAlphaEvent(
  value: unknown,
  sessionId: string,
  wireVersion: AlphaSessionWireVersion = 'v0',
  autoReviewDenialContract = false,
  profile?: AlphaV4SessionProfile,
): Record<string, unknown> | undefined {
  const event = recordOrUndefined(value)
  if (event === undefined || typeof event.type !== 'string') return undefined
  if (event.type === UNREADABLE_HISTORY_EVENT) return { ...historyMarker(event), sessionId }
  const normalized =
    wireVersion === 'v2'
      ? normalizeAlpha13Event(event)
      : wireVersion === 'v4'
        ? normalizeV4Event(event, profile)
        : event
  return { ...withAutoReviewDenialContract(normalized, autoReviewDenialContract), sessionId }
}

/** Keep the verified v2 event surface while ignoring additive upstream keys. */
function normalizeAlpha13Event(value: Record<string, unknown>): Record<string, unknown> {
  const event: Record<string, unknown> = {
    type: value.type,
    seq: value.seq,
    time: value.time,
    data: value.data,
  }
  for (const key of ['ignorable', 'sourceEventSeqs', 'surfaceOp']) {
    if (Object.hasOwn(value, key)) event[key] = value[key]
  }
  return event
}

export function expandHistoryRecords(
  records: readonly unknown[],
  sessionId: string,
  wireVersion: AlphaSessionWireVersion = 'v0',
  autoReviewDenialContract = false,
  profile?: AlphaV4SessionProfile,
): readonly Record<string, unknown>[] {
  const v2 = wireVersion === 'v2'
  const v3 = wireVersion === 'v3'
  const v4 = wireVersion === 'v4'
  const out: Record<string, unknown>[] = []
  for (const raw of records) {
    if (v4) {
      const readable = readAlpha171HistoryRecord(raw, profile)
      if (readable !== undefined)
        out.push({
          ...withAutoReviewDenialContract(
            normalizeV4Event(readable.event, profile),
            autoReviewDenialContract,
          ),
          sessionId,
        })
      continue
    }
    const record = recordOrUndefined(raw)
    if (record?.type === 'event') {
      const readable = readLegacyAlphaEvent(record, wireVersion)
      if (readable === undefined) continue
      const event = readable.event
      if (event.type === UNREADABLE_HISTORY_EVENT) {
        out.push({ ...historyMarker(event), sessionId })
        continue
      }
      out.push({
        ...withAutoReviewDenialContract(v2 ? normalizeAlpha13Event(event) : event, autoReviewDenialContract),
        sessionId,
      })
    } else if (!v2 && !v3 && record?.type === 'chunks') {
      try {
        out.push(...expandChunkRow(record.event, sessionId))
      } catch {
        const event = recordOrUndefined(record.event)
        if (event !== undefined && isSafeAlphaSequence(event.seq) && Number.isSafeInteger(event.time))
          out.push({ ...historyMarker(event), sessionId })
      }
    }
  }
  // The Gateway snapshot is a set of history records, not the stream's
  // delivery order. A packed chunk row can expand to many sequence values,
  // and different rows may arrive interleaved. DshStreamController uses the
  // durable sequence as its de-duplication watermark, so forwarding a higher
  // row before an earlier one would make the earlier conversation/tool data
  // look stale and drop it until the next history reload.
  return out
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const sequenceDelta = (left.event.seq as number) - (right.event.seq as number)
      return sequenceDelta === 0 ? left.index - right.index : sequenceDelta
    })
    .map(({ event }) => event)
}

/**
 * Incrementally decode + normalize a V4 snapshot's history records, yielding
 * after 64 rows or approximately 8ms of synchronous work. This is the
 * streaming-path replacement for `expandHistoryRecords` on `v4`: it also applies
 * the `seq <= cursor` admission that `readAlpha171SessionSnapshot` would otherwise
 * perform synchronously, so a snapshot's records are not decoded twice.
 */
export async function expandV4HistoryRecordsIncremental(
  records: readonly unknown[],
  sessionId: string,
  cursor: number,
  autoReviewDenialContract: boolean,
  profile?: AlphaV4SessionProfile,
  signal?: AbortSignal,
): Promise<readonly Record<string, unknown>[]> {
  const out: { event: Record<string, unknown>; index: number }[] = []
  let lastYield = performance.now()
  for (let index = 0; index < records.length; index++) {
    if (signal?.aborted === true) return []
    const readable = readAlpha171HistoryRecord(records[index], profile)
    if (readable !== undefined && readable.event.seq <= cursor)
      out.push({
        event: {
          ...withAutoReviewDenialContract(
            normalizeV4Event(readable.event, profile),
            autoReviewDenialContract,
          ),
          sessionId,
        },
        index,
      })
    if ((index + 1) % STREAM_BATCH_SIZE === 0 || performance.now() - lastYield >= STREAM_TIME_SLICE_MS) {
      await yieldToEventLoop(signal)
      lastYield = performance.now()
    }
  }
  // Flush any deferred heartbeat pong before the final order-by-sequence pass,
  // which is the one remaining synchronous phase of this incremental decode.
  await yieldToEventLoop(signal)
  if (signal?.aborted === true) return []
  return out
    .sort((left, right) => {
      const sequenceDelta = (left.event.seq as number) - (right.event.seq as number)
      return sequenceDelta === 0 ? left.index - right.index : sequenceDelta
    })
    .map(({ event }) => event)
}

function withAutoReviewDenialContract(
  event: Record<string, unknown>,
  enabled: boolean,
): Record<string, unknown> {
  return enabled && event.type === 'tool/result' ? { ...event, autoReviewDenialContract: true } : event
}

export function validAlphaWireSnapshot(
  value: unknown,
  wireVersion: AlphaSessionWireVersion,
  profile?: AlphaV4SessionProfile,
): value is AlphaSessionSnapshot {
  return wireVersion === 'v4'
    ? validAlpha171SessionSnapshot(value, profile)
    : wireVersion === 'v3'
      ? validAlpha151SessionSnapshot(value)
      : validAlphaSessionSnapshot(value, wireVersion === 'v2')
}

export function readAlphaWireSnapshot(
  value: unknown,
  wireVersion: AlphaSessionWireVersion,
  profile?: AlphaV4SessionProfile,
): AlphaSessionSnapshot | undefined {
  if (wireVersion === 'v4') return readAlpha171SessionSnapshot(value, profile)
  const source = recordOrUndefined(value)
  if (source?.type !== 'snapshot' || !Array.isArray(source.records)) return undefined
  const snapshot = {
    type: 'snapshot',
    header: source.header,
    cursor: source.cursor,
    records: [],
    hasMore: source.hasMore,
    projections: source.projections,
  }
  if (!validAlphaWireSnapshot(snapshot, wireVersion, profile)) return undefined
  return {
    ...snapshot,
    records: source.records,
    ...(source.assistantStream === undefined ? {} : { assistantStream: source.assistantStream }),
  }
}

/** A validated snapshot envelope of any wire version whose records stay undecoded. */
export interface AlphaWireSnapshotEnvelope {
  readonly header: Record<string, unknown>
  readonly cursor: number
  readonly records: readonly unknown[]
  readonly hasMore: boolean
  readonly projections: Record<string, unknown> | undefined
  readonly assistantStream?: unknown
}

/**
 * Validate a snapshot envelope without decoding its history records. The v4
 * per-record codec admission is the expensive part of a snapshot read; the
 * history RPC needs only the cursor from a follow tail, and expands the rows
 * it actually returns exactly once.
 */
export function readAlphaWireSnapshotEnvelope(
  value: unknown,
  wireVersion: AlphaSessionWireVersion,
  profile?: AlphaV4SessionProfile,
): AlphaWireSnapshotEnvelope | undefined {
  if (wireVersion === 'v4') return readAlpha171SessionSnapshotEnvelope(value, profile)
  const snapshot = readAlphaWireSnapshot(value, wireVersion, profile)
  if (snapshot === undefined) return undefined
  return {
    header: snapshot.header,
    cursor: snapshot.cursor,
    records: snapshot.records,
    hasMore: snapshot.hasMore,
    projections: snapshot.projections,
    ...(snapshot.assistantStream === undefined ? {} : { assistantStream: snapshot.assistantStream }),
  }
}

export function readAlphaWireEventFrame(
  value: unknown,
  wireVersion: AlphaSessionWireVersion,
  profile?: AlphaV4SessionProfile,
): AlphaSessionEventFrame | undefined {
  if (wireVersion === 'v4') return readAlpha171HistoryRecord(value, profile)
  return readLegacyAlphaEvent(value, wireVersion)
}

function readLegacyAlphaEvent(
  value: unknown,
  wireVersion: AlphaSessionWireVersion,
): AlphaSessionEventFrame | undefined {
  const frame = recordOrUndefined(value)
  const source = recordOrUndefined(frame?.event)
  if (
    frame?.type !== 'event' ||
    source === undefined ||
    !isSafeAlphaSequence(source.seq) ||
    Object.is(source.seq, -0)
  )
    return undefined
  const event: Record<string, unknown> = {
    type: source.type,
    seq: source.seq,
    time: source.time,
    data: source.data,
  }
  for (const key of ['ignorable', 'surfaceOp', 'sourceEventSeqs'])
    if (Object.hasOwn(source, key)) event[key] = source[key]
  const normalized = { type: 'event' as const, event }
  return validAlphaWireEventFrame(normalized, wireVersion)
    ? normalized
    : { type: 'event', event: { ...historyMarker(event), type: UNREADABLE_HISTORY_EVENT } }
}

function historyMarker(event: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'system/message',
    seq: event.seq,
    time: typeof event.time === 'number' && Number.isSafeInteger(event.time) ? event.time : 0,
    data: {},
  }
}

export function validAlphaWireEventFrame(
  value: unknown,
  wireVersion: AlphaSessionWireVersion,
  profile?: AlphaV4SessionProfile,
): value is AlphaSessionEventFrame {
  return wireVersion === 'v4'
    ? validAlpha171SessionEventFrame(value, profile)
    : wireVersion === 'v3'
      ? validAlpha151SessionEventFrame(value)
      : validAlphaSessionEventFrame(value, wireVersion === 'v2')
}

function expandChunkRow(value: unknown, sessionId: string): readonly Record<string, unknown>[] {
  const row = recordOrUndefined(value)
  const data = recordOrUndefined(row?.data)
  const rowType =
    row?.type === 'chunkrow/text-chunks' ||
    row?.type === 'chunkrow/reasoning-chunks' ||
    row?.type === 'chunkrow/tool-call-chunks'
      ? row.type.slice('chunkrow/'.length)
      : undefined
  if (
    row === undefined ||
    data === undefined ||
    rowType === undefined ||
    !hasExactKeys(row, ['type', 'seq', 'time', 'data']) ||
    !Number.isSafeInteger(row.seq) ||
    (row.seq as number) < 0 ||
    !Number.isSafeInteger(row.time) ||
    typeof data.turn !== 'number' ||
    typeof data.step !== 'number' ||
    typeof data.index !== 'number'
  )
    throw malformedResponse('chunk row')
  const dataKeys =
    rowType === 'tool-call-chunks'
      ? Object.hasOwn(data, 'name')
        ? ['turn', 'step', 'index', 'id', 'name', 'dt', 'args']
        : ['turn', 'step', 'index', 'id', 'dt', 'args']
      : ['turn', 'step', 'index', 'dt', 'texts']
  if (!hasExactKeys(data, dataKeys)) throw malformedResponse('chunk row data')
  const turn = data.turn
  const step = data.step
  const blockIndex = data.index
  if (typeof turn !== 'number' || typeof step !== 'number' || typeof blockIndex !== 'number')
    throw malformedResponse('chunk row data')
  const payloadKey = rowType === 'tool-call-chunks' ? 'args' : 'texts'
  const payload = data[payloadKey]
  const gaps = data.dt
  if (
    !Array.isArray(payload) ||
    payload.length === 0 ||
    !payload.every((entry) => typeof entry === 'string') ||
    !Array.isArray(gaps) ||
    gaps.length !== payload.length - 1 ||
    !gaps.every(Number.isSafeInteger)
  )
    throw malformedResponse('chunk row data')
  if (
    rowType === 'tool-call-chunks' &&
    (typeof data.id !== 'string' || (Object.hasOwn(data, 'name') && typeof data.name !== 'string'))
  )
    throw malformedResponse('tool chunk row')
  if (payload.length - 1 > Number.MAX_SAFE_INTEGER - (row.seq as number))
    throw malformedResponse('chunk row sequence')
  const out: Record<string, unknown>[] = []
  let time = row.time as number
  for (let memberIndex = 0; memberIndex < payload.length; memberIndex += 1) {
    if (memberIndex > 0) time += gaps[memberIndex - 1] as number
    if (!Number.isSafeInteger(time)) throw malformedResponse('chunk row time')
    const chunk =
      rowType === 'text-chunks'
        ? { type: 'text-delta', index: blockIndex, text: payload[memberIndex] }
        : rowType === 'reasoning-chunks'
          ? { type: 'reasoning-delta', index: blockIndex, text: payload[memberIndex] }
          : {
              type: 'tool-call-delta',
              index: blockIndex,
              id: data.id,
              ...(data.name === undefined ? {} : { name: data.name }),
              argumentsDelta: payload[memberIndex],
            }
    out.push({
      type: 'assistant/chunk',
      seq: (row.seq as number) + memberIndex,
      time,
      data: { turn, step, chunk },
      sessionId,
    })
  }
  return out
}

export function alphaEventOutcome(result: unknown, kind: 'approval' | 'question'): Record<string, unknown> {
  const value = asRecord(result)
  if (value?.ok === true) {
    const resultValue = alphaInteractionResult(value.value, kind)
    return { kind: 'result', ...(resultValue === undefined ? {} : { value: resultValue }) }
  }
  if (value?.ok === false) {
    const error = asRecord(value.error) ?? {}
    return {
      kind: 'rejected',
      error: {
        name: 'DshInteractionError',
        message: typeof error.message === 'string' ? error.message : 'The DSH interaction was rejected.',
        ...(typeof error.code === 'string' ? { code: error.code } : {}),
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }
  }
  return {
    kind: 'rejected',
    error: {
      name: 'DshInteractionError',
      message: 'The DSH interaction response was malformed.',
      code: 'bad-request',
      details: {},
    },
  }
}

/**
 * The interaction repository uses the rc.6 client-response value for every
 * transport. Alpha Remote Events resolve the original Cordis waterfall
 * directly, so remove that compatibility envelope at this version boundary.
 */
function alphaInteractionResult(value: unknown, kind: 'approval' | 'question'): unknown {
  const record = asRecord(value)
  if (record === undefined) return value
  if (kind === 'question' && asRecord(record.answer) !== undefined) return record.answer
  if (kind === 'approval' && typeof record.outcome === 'string') return record.outcome
  return value
}

export interface AlphaSessionSnapshot extends Record<string, unknown> {
  readonly type: 'snapshot'
  readonly header: Record<string, unknown>
  readonly cursor: number
  readonly records: readonly unknown[]
  readonly hasMore: boolean
  readonly projections: Record<string, unknown>
  readonly assistantStream?: unknown
}

export interface AlphaSessionEventFrame extends Record<string, unknown> {
  readonly type: 'event'
  readonly event: Record<string, unknown>
}

export interface AlphaEventReady extends Record<string, unknown> {
  readonly type: 'ready'
  readonly clientId: string
}

export interface AlphaEventEmit extends Record<string, unknown> {
  readonly type: 'emit'
  readonly event: string
  readonly args: readonly unknown[]
}

export interface AlphaEventWaterfall extends Record<string, unknown> {
  readonly type: 'waterfall'
  readonly event: string
  readonly eventId: string
  readonly agentId: string
  readonly request: Record<string, unknown>
}

export interface AlphaEventCancel extends Record<string, unknown> {
  readonly type: 'cancel'
  readonly eventId: string
}

function validAlphaSessionSnapshot(value: unknown, v2 = false): value is AlphaSessionSnapshot {
  const record = recordOrUndefined(value)
  const keysAreValid =
    record !== undefined &&
    (v2
      ? hasExactKeys(
          record,
          Object.hasOwn(record, 'assistantStream')
            ? ['type', 'header', 'cursor', 'records', 'hasMore', 'projections', 'assistantStream']
            : ['type', 'header', 'cursor', 'records', 'hasMore', 'projections'],
        )
      : true)
  return (
    record !== undefined &&
    keysAreValid &&
    record.type === 'snapshot' &&
    isPlainRecord(record.header) &&
    (!v2 || validAlpha13SessionHeader(record.header)) &&
    isSafeAlphaCursor(record.cursor) &&
    Array.isArray(record.records) &&
    (!v2 || record.records.every(validAlpha13HistoryRecord)) &&
    typeof record.hasMore === 'boolean' &&
    validAlphaProjectionBaseline(record.projections, v2)
  )
}

function validAlpha13SessionHeader(value: Record<string, unknown>): boolean {
  return (
    typeof value.version === 'number' &&
    Number.isSafeInteger(value.version) &&
    value.version >= 0 &&
    typeof value.id === 'string' &&
    value.id.trim() !== '' &&
    typeof value.createdAt === 'number' &&
    Number.isSafeInteger(value.createdAt) &&
    value.createdAt >= 0 &&
    typeof value.isSeeded === 'boolean' &&
    (value.cwd === undefined || typeof value.cwd === 'string') &&
    (value.parentSession === undefined || typeof value.parentSession === 'string') &&
    (value.origin === undefined || value.origin === 'subagent') &&
    (value.delegationDepth === undefined ||
      (Number.isSafeInteger(value.delegationDepth) && (value.delegationDepth as number) >= 0)) &&
    (value.agentPreset === undefined || typeof value.agentPreset === 'string')
  )
}

function validAlpha13HistoryRecord(value: unknown): boolean {
  const record = recordOrUndefined(value)
  const event = recordOrUndefined(record?.event)
  return (
    record !== undefined &&
    hasExactKeys(record, ['type', 'event']) &&
    record.type === 'event' &&
    event !== undefined &&
    validAlpha13SessionEvent(event)
  )
}

function validAlphaSessionEventFrame(value: unknown, v2 = false): value is AlphaSessionEventFrame {
  const record = recordOrUndefined(value)
  const event = record?.event
  return (
    record?.type === 'event' &&
    (!v2 || hasExactKeys(record, ['type', 'event'])) &&
    isPlainRecord(event) &&
    (v2 ? validAlpha13SessionEvent(event) : validAlphaSessionEvent(event))
  )
}

function validAlphaSessionEvent(value: Record<string, unknown>): boolean {
  return (
    typeof value.type === 'string' &&
    value.type.length > 0 &&
    isSafeAlphaSequence(value.seq) &&
    typeof value.time === 'number' &&
    Number.isSafeInteger(value.time) &&
    value.time >= 0 &&
    (value.ignorable === undefined || value.ignorable === true) &&
    isJsonLike(value.data)
  )
}

function validAlpha13SessionEvent(value: Record<string, unknown>): boolean {
  const surfaceOp = value.surfaceOp
  const replacement = recordOrUndefined(surfaceOp)
  const sourceEventSeqs = value.sourceEventSeqs
  return (
    validAlphaSessionEvent(value) &&
    (sourceEventSeqs === undefined ||
      (Array.isArray(sourceEventSeqs) && sourceEventSeqs.every(isSafeAlphaSequence))) &&
    (surfaceOp === undefined ||
      surfaceOp === 'append' ||
      (replacement !== undefined &&
        hasExactKeys(replacement, ['op', 'start', 'end']) &&
        replacement.op === 'replace' &&
        isSafeAlphaSequence(replacement.start) &&
        isSafeAlphaSequence(replacement.end)))
  )
}

export function validAlphaProjectionBaseline(value: unknown, v2 = false): value is Record<string, unknown> {
  const projection = isPlainRecord(value) ? value : undefined
  return (
    projection !== undefined &&
    (!v2 || hasExactKeys(projection, ['asOfSeq', 'values'])) &&
    isSafeAlphaCursor(projection.asOfSeq) &&
    isPlainRecord(projection.values)
  )
}

export function validAlphaEventReady(value: unknown): value is AlphaEventReady {
  const record = recordOrUndefined(value)
  const host = record?.host
  return (
    record !== undefined &&
    record.type === 'ready' &&
    isNonEmptyString(record.clientId) &&
    isPlainRecord(host) &&
    typeof host.home === 'string'
  )
}

export function validAlphaEventEmit(value: unknown): value is AlphaEventEmit {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    record.type === 'emit' &&
    isNonEmptyString(record.event) &&
    Array.isArray(record.args) &&
    isJsonLike(record.args)
  )
}

export function validAlphaEventWaterfall(value: unknown): value is AlphaEventWaterfall {
  const record = recordOrUndefined(value)
  const request = record?.request
  return (
    record !== undefined &&
    record.type === 'waterfall' &&
    isNonEmptyString(record.event) &&
    isNonEmptyString(record.eventId) &&
    isNonEmptyString(record.agentId) &&
    isPlainRecord(request) &&
    !Object.hasOwn(request, 'agent') &&
    !Object.hasOwn(request, 'signal') &&
    isJsonLike(request)
  )
}

export function validAlphaEventCancel(value: unknown): value is AlphaEventCancel {
  const record = recordOrUndefined(value)
  return record !== undefined && record.type === 'cancel' && isNonEmptyString(record.eventId)
}

function workspaceTitleFromPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const segments = value
    .trim()
    .replace(/[\\/]+$/u, '')
    .split(/[\\/]/u)
    .filter(Boolean)
  return segments.at(-1)
}
