/** DSH 0.1.7-alpha.1 Session Controller control wire. */

import { validAlpha171ProjectionBaseline } from './session-wire.js'

export type Alpha171ControlOutput =
  | {
      readonly type: 'session/projection-baseline'
      readonly projections: Readonly<
        Record<string, { readonly asOfSequence: number; readonly values: Readonly<Record<string, unknown>> }>
      >
    }
  | {
      readonly type: 'session/projection'
      readonly sessionId: string
      readonly key: string
      readonly value: unknown
      readonly seq: number
    }

/** Normalize the projection-only alpha171 control stream. */
export function normalizeAlpha171ControlFrame(value: unknown): readonly Alpha171ControlOutput[] | undefined {
  const frame = plainRecord(value)
  if (frame === undefined) return undefined
  if (frame.type === 'baseline') {
    if (!hasExactKeys(frame, ['type', 'value'])) return undefined
    return baseline(frame.value)
  }
  if (frame.type === 'projection') return projectionFrame(frame)
  return undefined
}

function baseline(value: unknown): readonly Alpha171ControlOutput[] | undefined {
  const record = plainRecord(value)
  if (record === undefined || !hasExactKeys(record, ['projections'])) return undefined
  const projections = plainRecord(record.projections)
  if (projections === undefined) return undefined
  const output = Object.create(null) as Record<
    string,
    { readonly asOfSequence: number; readonly values: Readonly<Record<string, unknown>> }
  >
  for (const [sessionId, value] of Object.entries(projections)) {
    if (!isNonEmptyString(sessionId) || !validAlpha171ProjectionBaseline(value)) return undefined
    const projection = plainRecord(value)
    const values = plainRecord(projection?.values)
    if (projection === undefined || values === undefined) return undefined
    output[sessionId] = { asOfSequence: projection.asOfSeq as number, values }
  }
  return [{ type: 'session/projection-baseline', projections: output }]
}

function projectionFrame(frame: Record<string, unknown>): readonly Alpha171ControlOutput[] | undefined {
  if (
    !hasExactKeys(frame, ['type', 'sessionId', 'key', 'value', 'seq']) ||
    !isNonEmptyString(frame.sessionId) ||
    !isNonEmptyString(frame.key) ||
    !isSafeSequence(frame.seq) ||
    !isJsonLike(frame.value)
  )
    return undefined
  return [
    {
      type: 'session/projection',
      sessionId: frame.sessionId,
      key: frame.key,
      value: frame.value,
      seq: frame.seq,
    },
  ]
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isSafeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0)
}

function isJsonLike(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.every((entry) => isJsonLike(entry, seen))
    const prototype = Reflect.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    return Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && isJsonLike(Reflect.get(value, key), seen),
    )
  } finally {
    seen.delete(value)
  }
}
