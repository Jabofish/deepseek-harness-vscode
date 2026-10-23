/**
 * Session Controller wire validation and readable V4 history projection.
 *
 * Alpha.171 serves native Session format V4. The released V4 codec validates
 * admission for interpreted events. Reading a native session degrades individual
 * unsupported records and leaves whole-artifact restoration to DSH. The
 * internal compatibility projection converts V4's tool-role result
 * to the established Domain tool-result representation after validation.
 */

import {
  assertReleasedV4Header,
  assertV4RowAdmission,
  RELEASED_V3_EVENT_TYPES,
  releasedV4SessionFormatCodec,
  restoreReleasedV4Artifact,
} from '@deepseek-ai/dsh-session-format-v3-to-v4'

const SESSION_EVENT_KEYS = [
  'type',
  'seq',
  'time',
  'data',
  'ignorable',
  'surfaceOp',
  'sourceEventSeqs',
] as const

/** Exact adapters extend V4 admission without changing older versions. */
export interface AlphaV4SessionProfile {
  readonly validateHeader?: (header: unknown) => void
  readonly validateEvent?: (event: unknown) => void
  readonly restoreArtifact?: (artifact: unknown, known: ReadonlySet<string>) => void
  readonly eventValidators: Readonly<Record<string, (data: unknown) => boolean>>
  readonly normalizeEvent?: (event: Record<string, unknown>) => Record<string, unknown>
}

const profileKnownTypes = new WeakMap<AlphaV4SessionProfile, ReadonlySet<string>>()

function knownTypes(profile?: AlphaV4SessionProfile): ReadonlySet<string> {
  if (profile === undefined) return KNOWN_SESSION_EVENT_TYPES
  const cached = profileKnownTypes.get(profile)
  if (cached !== undefined) return cached
  const types = new Set([...KNOWN_SESSION_EVENT_TYPES, ...Object.keys(profile.eventValidators)])
  profileKnownTypes.set(profile, types)
  return types
}

export interface Alpha171SessionEvent extends Record<string, unknown> {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

export interface Alpha171SessionHistoryRecord extends Record<string, unknown> {
  readonly type: 'event'
  readonly event: Alpha171SessionEvent
}

export interface Alpha171SessionSnapshot extends Record<string, unknown> {
  readonly type: 'snapshot'
  readonly header: Record<string, unknown>
  readonly cursor: number
  readonly records: readonly Alpha171SessionHistoryRecord[]
  readonly hasMore: boolean
  readonly projections: Record<string, unknown>
  readonly assistantStream?: unknown
}

export const UNREADABLE_HISTORY_EVENT = 'vscode/unreadable-history-record'

/** Keep the upstream cursor even when this client cannot interpret one record. */
export function readAlpha171HistoryRecord(
  value: unknown,
  profile?: AlphaV4SessionProfile,
): Alpha171SessionHistoryRecord | undefined {
  const record = plainRecord(value)
  const source = plainRecord(record?.event)
  if (record?.type !== 'event' || source === undefined || !isSafeSequence(source.seq)) return undefined
  // Additional envelope metadata is not a reason to lose a known message.
  const event = Object.fromEntries(
    SESSION_EVENT_KEYS.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]),
  )
  if (
    typeof event.type === 'string' &&
    knownTypes(profile).has(event.type) &&
    validAlpha171SessionEvent(event, profile)
  )
    return { type: 'event', event }
  // This marker has no payload or control semantics. The native projections
  // and Job Controller remain authoritative; never replay an unknown body.
  return {
    type: 'event',
    event: {
      type: UNREADABLE_HISTORY_EVENT,
      seq: source.seq,
      time: isSafeTime(source.time) ? source.time : 0,
      data: {},
      ignorable: true,
    },
  }
}

/** A validated V4 snapshot envelope whose history records are left undecoded. */
export interface Alpha171SessionSnapshotEnvelope {
  readonly header: Record<string, unknown>
  readonly cursor: number
  readonly records: readonly unknown[]
  readonly hasMore: boolean
  readonly projections: Record<string, unknown>
  readonly assistantStream?: unknown
}

/**
 * Validate a V4 snapshot envelope without decoding its history records. The
 * per-record V4 codec admission is the expensive part of
 * `readAlpha171SessionSnapshot`; the stream path decodes records incrementally
 * so a large history snapshot cannot starve the transport heartbeat.
 */
export function readAlpha171SessionSnapshotEnvelope(
  value: unknown,
  profile?: AlphaV4SessionProfile,
): Alpha171SessionSnapshotEnvelope | undefined {
  const record = plainRecord(value)
  const header = plainRecord(record?.header)
  if (
    record?.type !== 'snapshot' ||
    header === undefined ||
    !validAlpha171SessionHeader(header, profile) ||
    !isSafeCursor(record.cursor) ||
    !Array.isArray(record.records) ||
    typeof record.hasMore !== 'boolean' ||
    !validAlpha171ProjectionBaseline(record.projections)
  )
    return undefined
  return {
    header,
    cursor: record.cursor,
    records: record.records,
    hasMore: record.hasMore,
    projections: record.projections,
    ...(record.assistantStream === undefined ? {} : { assistantStream: record.assistantStream }),
  }
}

/** A view reads an already restored DSH session, not a complete persisted artifact. */
export function readAlpha171SessionSnapshot(
  value: unknown,
  profile?: AlphaV4SessionProfile,
): Alpha171SessionSnapshot | undefined {
  const envelope = readAlpha171SessionSnapshotEnvelope(value, profile)
  if (envelope === undefined) return undefined
  const records: Alpha171SessionHistoryRecord[] = []
  for (const raw of envelope.records) {
    const readable = readAlpha171HistoryRecord(raw, profile)
    if (readable !== undefined && readable.event.seq <= envelope.cursor) records.push(readable)
  }
  return { type: 'snapshot', ...envelope, records }
}

export function validAlpha171SessionEvent(
  value: unknown,
  profile?: AlphaV4SessionProfile,
): value is Alpha171SessionEvent {
  const event = plainRecord(value)
  if (
    event === undefined ||
    !hasKeysWithin(event, SESSION_EVENT_KEYS) ||
    typeof event.type !== 'string' ||
    event.type.trim() === '' ||
    !isSafeSequence(event.seq) ||
    !isSafeTime(event.time) ||
    !Object.hasOwn(event, 'data') ||
    !isJsonLike(event.data) ||
    (Object.hasOwn(event, 'ignorable') && event.ignorable !== true) ||
    (event.sourceEventSeqs !== undefined && !isJsonLike(event.sourceEventSeqs)) ||
    (event.surfaceOp !== undefined && !isJsonLike(event.surfaceOp))
  )
    return false

  try {
    const known = knownTypes(profile)
    if (!known.has(event.type)) return event.ignorable === true
    const validate = profile?.eventValidators[event.type]
    if (validate !== undefined && !validate(event.data)) return false
    validateSurfaceMetadata(event as Alpha171SessionEvent, known)
    assertV4RowAdmission(event, known)
    validateMessageSources(event as Alpha171SessionEvent)
    if (profile?.validateEvent !== undefined) profile.validateEvent(event)
    else
      releasedV4SessionFormatCodec.encodeEvent(
        event as Parameters<typeof releasedV4SessionFormatCodec.encodeEvent>[0],
      )
    if (event.type === 'tool/result' && !validV4ToolResultEvent(event)) return false
    const data = plainRecord(event.data)
    if (
      event.type === 'developer/message' &&
      data?.headerSeq !== undefined &&
      (!isSafeSequence(data.headerSeq) || data.headerSeq >= event.seq)
    )
      return false
    return true
  } catch {
    return false
  }
}

export function validAlpha171HistoryRecord(
  value: unknown,
  profile?: AlphaV4SessionProfile,
): value is Alpha171SessionHistoryRecord {
  const record = plainRecord(value)
  return (
    record !== undefined &&
    hasExactKeys(record, ['type', 'event']) &&
    record.type === 'event' &&
    validAlpha171SessionEvent(record.event, profile)
  )
}

export function validAlpha171SessionSnapshot(
  value: unknown,
  profile?: AlphaV4SessionProfile,
): value is Alpha171SessionSnapshot {
  const record = plainRecord(value)
  if (record === undefined || record.type !== 'snapshot') return false
  const expectedKeys = Object.hasOwn(record, 'assistantStream')
    ? ['type', 'header', 'cursor', 'records', 'hasMore', 'projections', 'assistantStream']
    : ['type', 'header', 'cursor', 'records', 'hasMore', 'projections']
  return (
    hasExactKeys(record, expectedKeys) &&
    validAlpha171SessionHeader(record.header, profile) &&
    isSafeCursor(record.cursor) &&
    Array.isArray(record.records) &&
    record.records.every((entry) => validAlpha171HistoryRecord(entry, profile)) &&
    validSnapshotRelationships(record, knownTypes(profile), profile) &&
    typeof record.hasMore === 'boolean' &&
    validAlpha171ProjectionBaseline(record.projections) &&
    (record.assistantStream === undefined || isJsonLike(record.assistantStream))
  )
}

export function validAlpha171ProjectionBaseline(value: unknown): value is Record<string, unknown> {
  const record = plainRecord(value)
  return (
    record !== undefined &&
    hasExactKeys(record, ['asOfSeq', 'values']) &&
    isSafeCursor(record.asOfSeq) &&
    plainRecord(record.values) !== undefined &&
    isJsonLike(record.values)
  )
}

export function validAlpha171SessionEventFrame(
  value: unknown,
  profile?: AlphaV4SessionProfile,
): value is { readonly type: 'event'; readonly event: Alpha171SessionEvent } {
  const record = plainRecord(value)
  return (
    record !== undefined &&
    hasExactKeys(record, ['type', 'event']) &&
    record.type === 'event' &&
    validAlpha171SessionEvent(record.event, profile)
  )
}

/** Project a validated native V4 tool result into the legacy internal mapper shape. */
export function normalizeAlpha171Event(value: Record<string, unknown>): Record<string, unknown> {
  if (value.type !== 'tool/result') return value
  if (!validV4ToolResultEvent(value)) throw new Error('Malformed alpha.1 tool/result V4 message')
  return projectToV3ToolResult(value)
}

function validV4ToolResultEvent(value: Record<string, unknown>): boolean {
  const data = plainRecord(value.data)
  const message = plainRecord(data?.message)
  const source = plainRecord(message?.source)
  const content = message?.content
  return (
    data !== undefined &&
    message !== undefined &&
    source !== undefined &&
    message.id !== undefined &&
    typeof message.id === 'string' &&
    message.id.length > 0 &&
    message.role === 'tool' &&
    source.kind === 'tool' &&
    typeof source.callId === 'string' &&
    source.callId.length > 0 &&
    typeof message.toolCallId === 'string' &&
    message.toolCallId.length > 0 &&
    message.toolCallId === source.callId &&
    Array.isArray(content) &&
    content.every((block) => isJsonLike(block)) &&
    !content.some((block) => plainRecord(block)?.type === 'tool-result') &&
    (message.isError === undefined || typeof message.isError === 'boolean') &&
    (data.error === undefined || message.isError === true)
  )
}

function projectToV3ToolResult(value: Record<string, unknown>): Record<string, unknown> {
  const data = plainRecord(value.data)
  const message = plainRecord(data?.message)
  if (data === undefined || message === undefined) throw new Error('Malformed alpha.1 tool/result V4 message')
  const resultBlock = {
    type: 'tool-result',
    toolCallId: message.toolCallId,
    content: message.content,
    ...(message.isError === undefined ? {} : { isError: message.isError }),
  }
  return {
    ...value,
    data: {
      ...data,
      message: {
        ...message,
        role: 'user',
        content: [resultBlock],
      },
    },
  }
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

function isSafeSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function isSafeCursor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1 && !Object.is(value, -0)
}

function isSafeTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
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
      for (let index = 0; index < value.length; index += 1)
        if (!Object.hasOwn(value, index) || !isJsonLike(value[index], seen)) return false
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

// V4 adds developer/message to the upstream released V3 vocabulary.
const KNOWN_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...RELEASED_V3_EVENT_TYPES,
  'developer/message',
])

/** Event types whose model-visible effects require an explicit pure interpreter. */
export const MESSAGE_PROJECTION_EVENT_TYPES: ReadonlySet<string> = new Set(['image/offload'])

const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'user/message',
  'developer/message',
  'assistant/message',
  'tool/result',
])
function validateSurfaceMetadata(event: Alpha171SessionEvent, known: ReadonlySet<string>): void {
  const isSurface = SURFACE_EVENT_TYPES.has(event.type)
  const surfaceOp = event.surfaceOp
  const sourceEventSeqs = event.sourceEventSeqs
  if (!isSurface) {
    // Unknown ignorable records may carry opaque metadata. Known and required
    // records must not silently acquire surface semantics.
    if (!(!known.has(event.type) && event.ignorable === true)) {
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

function validAlpha171SessionHeader(value: unknown, profile?: AlphaV4SessionProfile): boolean {
  try {
    ;(profile?.validateHeader ?? assertReleasedV4Header)(headerForArtifactValidation(value))
    return true
  } catch {
    return false
  }
}

/** The live V4 header omits top-level depth (meaning zero); the artifact validator requires it. */
function headerForArtifactValidation(value: unknown): unknown {
  const header = plainRecord(value)
  return header !== undefined && !Object.hasOwn(header, 'delegationDepth') && header.origin !== 'subagent'
    ? { ...header, delegationDepth: 0 }
    : value
}

function validateMessageSources(event: Alpha171SessionEvent): void {
  const data = plainRecord(event.data)
  if (data === undefined) return
  const messages =
    event.type === 'user/message'
      ? [data]
      : SURFACE_EVENT_TYPES.has(event.type)
        ? [data.message]
        : event.type === 'agent/inbox/spliced'
          ? data.inserted
          : event.type === 'session/title-llm-request'
            ? data.messages
            : []
  if (!Array.isArray(messages)) throw new Error('Invalid V4 message array')
  for (const value of messages) {
    const message = plainRecord(value)
    const source = plainRecord(message?.source)
    if (
      message === undefined ||
      typeof message.id !== 'string' ||
      message.id.length === 0 ||
      !Array.isArray(message.content) ||
      source === undefined ||
      typeof source.kind !== 'string' ||
      source.kind.length === 0 ||
      source.kind === 'plugin'
    )
      throw new Error('Invalid V4 message source')
    const role =
      event.type === 'user/message'
        ? 'user'
        : event.type === 'system/message'
          ? 'system'
          : event.type === 'developer/message'
            ? 'developer'
            : event.type === 'assistant/message'
              ? 'assistant'
              : event.type === 'tool/result'
                ? 'tool'
                : undefined
    if (role !== undefined && message.role !== role) throw new Error('Invalid V4 message role')
  }
}

function validSnapshotRelationships(
  snapshot: Record<string, unknown>,
  known: ReadonlySet<string>,
  profile?: AlphaV4SessionProfile,
): boolean {
  const records = snapshot.records as Alpha171SessionHistoryRecord[]
  const events = records.map((record) => record.event)
  for (let i = 1; i < events.length; i++) if (events[i]!.seq <= events[i - 1]!.seq) return false
  if (events.some((event) => event.seq > (snapshot.cursor as number))) return false
  // A paginated suffix cannot prove absent predecessors. Check whole-artifact
  // ownership only when the snapshot actually contains the complete log.
  if (snapshot.hasMore === true || events.some((event, index) => event.seq !== index)) return true
  try {
    const inherited =
      events
        .filter((event) => event.type === 'session/end-seed' && plainRecord(event.data)?.inherited === true)
        .at(-1)?.seq ?? 0
    ;(profile?.restoreArtifact ?? restoreReleasedV4Artifact)(
      {
        header: headerForArtifactValidation(snapshot.header),
        inheritedEventCount: inherited,
        events,
      } as Parameters<typeof restoreReleasedV4Artifact>[0],
      known,
    )
    return true
  } catch {
    return false
  }
}
