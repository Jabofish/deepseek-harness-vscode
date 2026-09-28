import { safePayload } from '../../redaction.js'
import { recordOrUndefined as objectOrUndefined } from '../../repositories/shared/guards.js'

export function object(value: unknown, label: string): Record<string, unknown> {
  const record = objectOrUndefined(value)
  if (record === undefined) throw new Error(`Malformed ${label}`)
  return record
}

export function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

export function requiredArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Malformed ${label}`)
  return value
}

export function contentEntries(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value
  return typeof value === 'string' ? [value] : []
}

export function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Malformed ${label}`)
  return value
}

export function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** Identify an event by its own durable sequence when its payload carries none. */
export function eventSequenceLabel(value: unknown): string {
  if (typeof value === 'string') return value === '' ? 'unknown' : value
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : 'unknown'
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? bounded(value) : undefined
}

export function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim() !== '')
}

export function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function validHistoryTime(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    const dateValue = new Date(value)
    return Number.isFinite(dateValue.getTime()) ? dateValue.toISOString() : undefined
  }
  return undefined
}

export function date(value: unknown): string {
  if (typeof value === 'string') return value
  const timestamp = number(value, Date.now())
  return new Date(timestamp).toISOString()
}

/** Preserve an event's real wall-clock boundary without manufacturing one. */
export function eventTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string') {
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : undefined
  }
  return undefined
}

export function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  fallback: T[number],
): T[number] {
  return typeof value === 'string' && values.includes(value) ? value : fallback
}

/**
 * Flatten a payload to text without truncating. A capped `grep`/`glob` result
 * carries its spill locator at the tail ("Full grep result stored at: …"), so
 * cutting here removes the one route back to the dropped rows; the pinned
 * reference client renders a settled result's text verbatim and unbounded for
 * the same reason. Callers own presentation and may fold or scroll it.
 */
export function fullText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(safePayload(value))
  return text ?? ''
}

/** Non-blank host-authored text kept whole, for a surface that renders it as sent. */
export function fullOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

export function bounded(value: unknown): string {
  return fullText(value).slice(0, 4_096)
}

export function eventIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function indexToken(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value === 'string' && value.trim() !== '') return value
  return undefined
}

export function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export function positiveSafeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export function nonNegativeSafeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function nonNegativeSafeSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function safeSubscriptionSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1
}

export function requiredStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`Malformed ${label}`)
  const entries: readonly unknown[] = value
  if (!entries.every((entry) => typeof entry === 'string' && entry.trim() !== ''))
    throw new Error(`Malformed ${label}`)
  return entries as readonly string[]
}

export function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
