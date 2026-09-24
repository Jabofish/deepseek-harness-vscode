/**
 * DSH 0.1.6-alpha.2 Session Controller wire.
 *
 * Alpha.2 removed the transient `queues` member from the control baseline.
 * Pending user input is now the durable `inbox` projection, whose two lists
 * still need to be projected into the queue DTO consumed by the existing
 * repositories. Keep that projection here so the alpha family transport does
 * not infer alpha.2 from a semver suffix or silently accept the old shape.
 */

export type Alpha162ControlOutput =
  | {
      readonly type: 'session/jobs'
      readonly sessionId: string
      readonly jobs: readonly Record<string, unknown>[]
    }
  | {
      readonly type: 'session/queue'
      readonly sessionId: string
      readonly items: readonly Record<string, unknown>[]
    }
  | {
      readonly type: 'session/projection'
      readonly sessionId: string
      readonly key: string
      readonly value: unknown
      readonly seq: number
    }

/** Normalize one alpha.2 control frame, or return undefined for protocol drift. */
export function normalizeAlpha162ControlFrame(value: unknown): readonly Alpha162ControlOutput[] | undefined {
  const frame = plainRecord(value)
  if (frame === undefined) return undefined
  if (frame.type === 'baseline') return baseline(frame.value)
  if (frame.type === 'jobs') return jobsFrame(frame)
  if (frame.type === 'projection') return projectionFrame(frame)
  return undefined
}

function baseline(value: unknown): readonly Alpha162ControlOutput[] | undefined {
  const record = plainRecord(value)
  if (record === undefined || !hasExactKeys(record, ['jobs', 'projections'])) return undefined
  const jobs = plainRecord(record.jobs)
  const projections = plainRecord(record.projections)
  if (jobs === undefined || projections === undefined) return undefined

  const output: Alpha162ControlOutput[] = []
  for (const [sessionId, value] of Object.entries(jobs)) {
    if (!isNonEmptyString(sessionId) || !validJobs(value)) return undefined
    output.push({ type: 'session/jobs', sessionId, jobs: value })
  }
  for (const [sessionId, value] of Object.entries(projections)) {
    if (!isNonEmptyString(sessionId)) return undefined
    const projection = projectionBaseline(value)
    if (projection === undefined) return undefined
    const frames = projectionFrames(sessionId, projection.values, projection.asOfSeq)
    if (frames === undefined) return undefined
    output.push(...frames)
  }
  return output
}

function jobsFrame(frame: Record<string, unknown>): readonly Alpha162ControlOutput[] | undefined {
  if (
    !hasExactKeys(frame, ['type', 'sessionId', 'jobs']) ||
    !isNonEmptyString(frame.sessionId) ||
    !validJobs(frame.jobs)
  )
    return undefined
  return [{ type: 'session/jobs', sessionId: frame.sessionId, jobs: frame.jobs }]
}

function projectionFrame(frame: Record<string, unknown>): readonly Alpha162ControlOutput[] | undefined {
  if (
    !hasExactKeys(frame, ['type', 'sessionId', 'key', 'value', 'seq']) ||
    !isNonEmptyString(frame.sessionId) ||
    !isNonEmptyString(frame.key) ||
    !isSafeSequence(frame.seq) ||
    !isJsonLike(frame.value)
  )
    return undefined
  return projectionFrames(frame.sessionId, { [frame.key]: frame.value }, frame.seq)
}

function projectionFrames(
  sessionId: string,
  values: Record<string, unknown>,
  seq: number,
): readonly Alpha162ControlOutput[] | undefined {
  const output: Alpha162ControlOutput[] = []
  for (const [key, value] of Object.entries(values)) {
    if (!isJsonLike(value)) return undefined
    if (key === 'inbox') {
      const items = inboxQueueItems(value)
      if (items === undefined) return undefined
      // The queue repository is the compatibility projection of the newer
      // Inbox state. Emit it before the projection watermark so one frame can
      // never publish a cursor for an Inbox value that was rejected locally.
      output.push({ type: 'session/queue', sessionId, items })
    }
    output.push({ type: 'session/projection', sessionId, key, value, seq })
  }
  return output
}

function projectionBaseline(
  value: unknown,
): { readonly asOfSeq: number; readonly values: Record<string, unknown> } | undefined {
  const record = plainRecord(value)
  if (
    record === undefined ||
    !hasExactKeys(record, ['asOfSeq', 'values']) ||
    !isSafeCursor(record.asOfSeq) ||
    !isPlainRecord(record.values)
  )
    return undefined
  return { asOfSeq: record.asOfSeq, values: record.values }
}

function validJobs(value: unknown): value is readonly Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isPlainRecord)
}

export function inboxQueueItems(value: unknown): readonly Record<string, unknown>[] | undefined {
  const inbox = plainRecord(value)
  if (
    inbox === undefined ||
    !hasExactKeys(inbox, ['next-turn', 'next-step']) ||
    !Array.isArray(inbox['next-turn']) ||
    !Array.isArray(inbox['next-step'])
  )
    return undefined

  const ids = new Set<string>()
  const items: Record<string, unknown>[] = []
  for (const [placement, entries] of [
    ['queued', inbox['next-turn']],
    ['steering', inbox['next-step']],
  ] as const) {
    for (const entry of entries) {
      const message = pendingMessage(entry)
      if (message === undefined || ids.has(message.id)) return undefined
      ids.add(message.id)
      const source = message.source
      const rpcId =
        source !== undefined &&
        source.kind === 'user' &&
        typeof source.rpcId === 'string' &&
        source.rpcId.trim() !== ''
          ? source.rpcId
          : undefined
      items.push({
        id: message.id,
        placement,
        message: { id: message.id, content: message.content },
        ...(rpcId === undefined ? {} : { rpcId }),
      })
    }
  }
  return items
}

interface PendingMessage {
  readonly id: string
  readonly content: readonly unknown[]
  readonly source?: { readonly kind: string; readonly rpcId?: unknown }
}

function pendingMessage(value: unknown): PendingMessage | undefined {
  const message = plainRecord(value)
  const source = message === undefined ? undefined : plainRecord(message.source)
  if (
    message === undefined ||
    !isNonEmptyString(message.id) ||
    message.role !== 'user' ||
    !Array.isArray(message.content) ||
    !message.content.every(validContentBlock) ||
    source === undefined ||
    !isNonEmptyString(source.kind) ||
    (source.kind === 'user' &&
      Object.hasOwn(source, 'rpcId') &&
      (typeof source.rpcId !== 'string' || source.rpcId.trim() === '')) ||
    !isJsonLike(message)
  )
    return undefined
  return {
    id: message.id,
    content: message.content,
    source: { kind: source.kind, ...(Object.hasOwn(source, 'rpcId') ? { rpcId: source.rpcId } : {}) },
  }
}

function validContentBlock(value: unknown): boolean {
  const block = plainRecord(value)
  return block !== undefined && isNonEmptyString(block.type) && isJsonLike(block)
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) return undefined
  return value
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Reflect.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isSafeCursor(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= -1
}

function isSafeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
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
