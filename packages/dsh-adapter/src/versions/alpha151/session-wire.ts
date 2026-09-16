/**
 * Strict Session Controller wire validation for the DSH 0.1.5 v3 family.
 *
 * The upstream v3 client validates the event envelope and the event-local
 * surface rules before handing a record to the journal projector. Keep this
 * validator independent from the upstream package so the extension can keep
 * all older adapters installed at the same time.
 */

const SURFACE_EVENT_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

/** Generated upstream vocabulary used to distinguish opaque ignorable rows. */
const KNOWN_SESSION_EVENT_TYPES = new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/attempt',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'deliverables/presented',
  'feedback/message-delete',
  'feedback/message-put',
  'feedback/record',
  'goal/change',
  'hook/invoked',
  'hook/result',
  'image/offload',
  'llm/retry',
  'llm/retry-started',
  'model/selection',
  'permission/preset',
  'plan/mode',
  'request/context',
  'request/header',
  'sandbox/mode',
  'schedule/change',
  'session-log-deepseek/delivery-accepted',
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'step/end',
  'step/start',
  'subagent/catalog',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'system/message',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'todo/write',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/call',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'tool/result',
  'turn/end',
  'turn/start',
  'user/message',
  'web/deepseek-search-llm-request',
])

const SESSION_EVENT_KEYS = [
  'type',
  'seq',
  'time',
  'data',
  'ignorable',
  'surfaceOp',
  'sourceEventSeqs',
] as const

export interface Alpha151SessionEvent extends Record<string, unknown> {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

export interface Alpha151SessionHistoryRecord extends Record<string, unknown> {
  readonly type: 'event'
  readonly event: Alpha151SessionEvent
}

export interface Alpha151SessionSnapshot extends Record<string, unknown> {
  readonly type: 'snapshot'
  readonly header: Record<string, unknown>
  readonly cursor: number
  readonly records: readonly Alpha151SessionHistoryRecord[]
  readonly hasMore: boolean
  readonly projections: Record<string, unknown>
  readonly assistantStream?: unknown
}

/** Validate one strict v3 Session event envelope and its local metadata. */
export function validAlpha151SessionEvent(value: unknown): value is Alpha151SessionEvent {
  try {
    assertAlpha151SessionEvent(value)
    return true
  } catch {
    return false
  }
}

/** Validate one strict v3 history record. Packed legacy chunk rows are absent. */
export function validAlpha151HistoryRecord(value: unknown): value is Alpha151SessionHistoryRecord {
  const record = plainRecord(value)
  return (
    record !== undefined &&
    hasExactKeys(record, ['type', 'event']) &&
    record.type === 'event' &&
    validAlpha151SessionEvent(record.event)
  )
}

/** Validate the exact v3 follow snapshot shape used by the Gateway. */
export function validAlpha151SessionSnapshot(value: unknown): value is Alpha151SessionSnapshot {
  const record = plainRecord(value)
  if (record === undefined || record.type !== 'snapshot') return false
  const expectedKeys = Object.hasOwn(record, 'assistantStream')
    ? ['type', 'header', 'cursor', 'records', 'hasMore', 'projections', 'assistantStream']
    : ['type', 'header', 'cursor', 'records', 'hasMore', 'projections']
  return (
    hasExactKeys(record, expectedKeys) &&
    validAlpha151SessionHeader(record.header) &&
    isSafeCursor(record.cursor) &&
    Array.isArray(record.records) &&
    record.records.every(validAlpha151HistoryRecord) &&
    typeof record.hasMore === 'boolean' &&
    validAlpha151ProjectionBaseline(record.projections) &&
    (record.assistantStream === undefined || isJsonLike(record.assistantStream))
  )
}

/** Validate the v3 header while retaining forward-compatible JSON fields. */
export function validAlpha151SessionHeader(value: unknown): value is Record<string, unknown> {
  const record = plainRecord(value)
  return (
    record !== undefined &&
    isJsonLike(record) &&
    typeof record.version === 'number' &&
    Number.isSafeInteger(record.version) &&
    record.version >= 0 &&
    typeof record.id === 'string' &&
    record.id.trim() !== '' &&
    typeof record.createdAt === 'number' &&
    Number.isSafeInteger(record.createdAt) &&
    record.createdAt >= 0 &&
    typeof record.isSeeded === 'boolean' &&
    (record.cwd === undefined || typeof record.cwd === 'string') &&
    (record.parentSession === undefined || typeof record.parentSession === 'string') &&
    (record.origin === undefined || record.origin === 'subagent') &&
    (record.delegationDepth === undefined ||
      (Number.isSafeInteger(record.delegationDepth) && (record.delegationDepth as number) >= 0)) &&
    (record.agentPreset === undefined || typeof record.agentPreset === 'string')
  )
}

/** Validate the v3 projection baseline used by a follow snapshot or page. */
export function validAlpha151ProjectionBaseline(value: unknown): value is Record<string, unknown> {
  const record = plainRecord(value)
  return (
    record !== undefined &&
    hasExactKeys(record, ['asOfSeq', 'values']) &&
    isSafeCursor(record.asOfSeq) &&
    plainRecord(record.values) !== undefined &&
    isJsonLike(record.values)
  )
}

/** Validate one event frame emitted after a v3 follow snapshot. */
export function validAlpha151SessionEventFrame(
  value: unknown,
): value is { readonly type: 'event'; readonly event: Alpha151SessionEvent } {
  const record = plainRecord(value)
  return (
    record !== undefined &&
    hasExactKeys(record, ['type', 'event']) &&
    record.type === 'event' &&
    validAlpha151SessionEvent(record.event)
  )
}

function assertAlpha151SessionEvent(value: unknown): asserts value is Alpha151SessionEvent {
  const event = plainRecord(value)
  if (event === undefined || !hasKeysWithin(event, SESSION_EVENT_KEYS))
    throw new Error('session wire event has unexpected fields')
  if (
    typeof event.type !== 'string' ||
    !isSafeSequence(event.seq) ||
    !isSafeTime(event.time) ||
    !Object.hasOwn(event, 'data') ||
    event.data === undefined ||
    !isJsonLike(event.data) ||
    (Object.hasOwn(event, 'ignorable') && event.ignorable !== true)
  )
    throw new Error('session wire event has an invalid envelope')
  for (const key of ['sourceEventSeqs', 'surfaceOp']) {
    if (Object.hasOwn(event, key) && event[key] === undefined)
      throw new Error('session wire event has undefined metadata')
  }
  if (event.sourceEventSeqs !== undefined && !isJsonLike(event.sourceEventSeqs))
    throw new Error('session wire event sourceEventSeqs is not JSON')
  if (event.surfaceOp !== undefined && !isJsonLike(event.surfaceOp))
    throw new Error('session wire event surfaceOp is not JSON')
  const typedEvent = event as Alpha151SessionEvent
  validateSurfaceMetadata(typedEvent)
  validateSessionEventData(typedEvent)
}

function validateSurfaceMetadata(event: Alpha151SessionEvent): void {
  const isSurface = SURFACE_EVENT_TYPES.has(event.type)
  const surfaceOp = event.surfaceOp
  const sourceEventSeqs = event.sourceEventSeqs
  if (!isSurface) {
    // Unknown ignorable records may carry opaque metadata. Known and required
    // records must not silently acquire surface semantics.
    if (!(!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable === true)) {
      if (surfaceOp !== undefined || sourceEventSeqs !== undefined)
        throw new Error('non-surface event carries surface metadata')
    }
    return
  }
  if (surfaceOp === undefined) throw new Error('surface event is missing surfaceOp')
  if (surfaceOp !== 'append') {
    const replacement = plainRecord(surfaceOp)
    if (
      replacement === undefined ||
      !hasExactKeys(replacement, ['op', 'startSeq', 'endSeq']) ||
      replacement.op !== 'replace' ||
      !isSafeSequence(replacement.startSeq) ||
      !isSafeSequence(replacement.endSeq) ||
      replacement.startSeq >= event.seq ||
      replacement.endSeq >= event.seq
    )
      throw new Error('surface event has an invalid replace operation')
  }
  if (event.type === 'assistant/message' && sourceEventSeqs !== undefined)
    throw new Error('assistant/message cannot carry sourceEventSeqs')
  if (sourceEventSeqs === undefined) return
  if (!Array.isArray(sourceEventSeqs) || sourceEventSeqs.length === 0)
    throw new Error('surface event sourceEventSeqs must be non-empty')
  const sources = new Set<number>()
  for (const source of sourceEventSeqs) {
    if (!isSafeSequence(source) || sources.has(source) || source >= event.seq)
      throw new Error('surface event sourceEventSeqs must be unique and earlier')
    sources.add(source)
  }
}

function validateSessionEventData(event: Alpha151SessionEvent): void {
  const data = plainRecord(event.data)
  if (event.type === 'request/header') {
    if (data === undefined) throw new Error('request/header data must be an object')
    const header = plainRecord(data.header)
    if (header === undefined) throw new Error('request/header header must be an object')
    if (Object.hasOwn(header, 'system')) throw new Error('request/header must omit header.system')
    if (Array.isArray(header.tools) && header.tools.length === 0)
      throw new Error('request/header must omit empty tools')
    const defaults = plainRecord(header.adapterDefaults)
    if (defaults !== undefined && Object.keys(defaults).length === 0)
      throw new Error('request/header must omit empty adapterDefaults')
  }
  if (event.type === 'tool/result') {
    if (data === undefined) throw new Error('tool/result data must be an object')
    if (data.error === undefined) return
    const message = plainRecord(data.message)
    const content = message?.content
    const first = Array.isArray(content) ? plainRecord(content[0]) : undefined
    if (first?.isError !== true) throw new Error('tool/result error requires an error result block')
  }
}

function isSafeSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function isSafeCursor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1 && !Object.is(value, -0)
}

function isSafeTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const prototype = Reflect.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : undefined
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function hasKeysWithin(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key))
}

function isJsonLike(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (
        Reflect.getPrototypeOf(value) !== Array.prototype ||
        Reflect.ownKeys(value).length !== value.length + 1
      )
        return false
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isJsonLike(value[index], seen)) return false
      }
      return true
    }
    const prototype = Reflect.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor?.enumerable !== true || !isJsonLike(Reflect.get(value, key), seen)) return false
    }
    return true
  } finally {
    seen.delete(value)
  }
}
