import type {
  ScheduleAtInput,
  ScheduleAtValue,
  ScheduleCatalogEntry,
  ScheduleDeleteResult,
  ScheduleDeliveryReceipt,
  ScheduleHistoryPage,
  ScheduleHistoryRequest,
  ScheduleHistoryResult,
  ScheduleMutationFailure,
  ScheduleRecord,
  ScheduleRepository,
  ScheduleTimingChange,
  ScheduleUpdateRequest,
  ScheduleUpdateResult,
} from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'

import type { DshTransport } from '../../contracts.js'
import { unwrapRpcResultValue } from '../rc6/rpc.js'

const MAX_HISTORY_LIMIT = 100

/** DSH 0.1.7-rc.2 Schedule Remotes, with exact Host types projected to Domain DTOs. */
export class Rc172ScheduleRepository implements ScheduleRepository {
  public constructor(private readonly transport: DshTransport) {}

  public async catalog(signal?: AbortSignal): Promise<readonly ScheduleCatalogEntry[]> {
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest('schedule/catalog', {}, signal),
      'schedule/catalog',
    )
    if (!Array.isArray(value)) throw malformed('catalog')
    return value.map(catalogEntry)
  }

  public async list(sessionId: string, signal?: AbortSignal): Promise<readonly ScheduleRecord[]> {
    requireIdentifier(sessionId, 'Session')
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest('schedule/list', { sessionId }, signal),
      'schedule/list',
    )
    if (!Array.isArray(value)) throw malformed('list')
    return value.map(scheduleRecord)
  }

  public async history(
    request: ScheduleHistoryRequest,
    signal?: AbortSignal,
  ): Promise<ScheduleHistoryResult> {
    validateHistoryRequest(request)
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest('schedule/history', toRemoteHistoryRequest(request), signal),
      'schedule/history',
    )
    const record = requiredRecord(value, 'history result')
    if (record.id !== request.id) throw malformed('history result')
    if (record.code === 'schedule_not_found' || record.code === 'delivery_cursor_not_found')
      return { id: record.id, code: record.code }
    return historyPage(record)
  }

  public async update(request: ScheduleUpdateRequest, signal?: AbortSignal): Promise<ScheduleUpdateResult> {
    validateUpdateRequest(request)
    const { sessionId, id, expected, title, prompt, change } = request
    const args = {
      sessionId,
      id,
      expected: toRemoteRecord(expected),
      ...(title === undefined ? {} : { title }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(change === undefined ? {} : { change: toRemoteTimingChange(change) }),
    }
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest('schedule/update', args, signal),
      'schedule/update',
    )
    return updateResult(value, id)
  }

  public async delete(sessionId: string, id: string, signal?: AbortSignal): Promise<ScheduleDeleteResult> {
    requireIdentifier(sessionId, 'Session')
    requireIdentifier(id, 'Schedule')
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest('schedule/delete', { sessionId, id }, signal),
      'schedule/delete',
    )
    return deleteResult(value, id)
  }
}

function catalogEntry(value: unknown): ScheduleCatalogEntry {
  const record = requiredRecord(value, 'catalog entry')
  if (!isNonEmptyString(record.sessionId) || (record.status !== 'active' && record.status !== 'inactive'))
    throw malformed('catalog entry')
  const schedule = scheduleRecord(record)
  const receipt = record.lastDelivery === undefined ? undefined : deliveryReceipt(record.lastDelivery)
  return {
    ...schedule,
    sessionId: record.sessionId,
    status: record.status,
    ...(receipt === undefined ? {} : { lastDelivery: receipt }),
  }
}

function scheduleRecord(value: unknown): ScheduleRecord {
  const record = requiredRecord(value, 'record')
  if (
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.title) ||
    record.title.length > 120 ||
    !isNonEmptyString(record.prompt) ||
    !isIsoTimestamp(record.scheduledAt) ||
    typeof record.kind !== 'string'
  )
    throw malformed('record')

  const common = {
    id: record.id,
    title: record.title,
    prompt: record.prompt,
    scheduledAt: record.scheduledAt,
  }
  switch (record.kind) {
    case 'at':
      return { ...common, kind: 'at' }
    case 'after':
      if (!isPositiveSafeInteger(record.afterSeconds)) throw malformed('record')
      return { ...common, kind: 'after', afterSeconds: record.afterSeconds }
    case 'every':
      if (!isPositiveSafeInteger(record.everySeconds)) throw malformed('record')
      return { ...common, kind: 'every', everySeconds: record.everySeconds }
    case 'daily':
      if (!isNonEmptyString(record.time) || !isNonEmptyString(record.timeZone)) throw malformed('record')
      return { ...common, kind: 'daily', time: record.time, timeZone: record.timeZone }
    case 'weekly':
      if (
        !isNonEmptyString(record.time) ||
        !isNonEmptyString(record.timeZone) ||
        !isWeekdays(record.weekdays)
      )
        throw malformed('record')
      return {
        ...common,
        kind: 'weekly',
        time: record.time,
        timeZone: record.timeZone,
        weekdays: [...record.weekdays],
      }
    case 'cron':
      if (!isNonEmptyString(record.expression) || !isNonEmptyString(record.timeZone))
        throw malformed('record')
      return { ...common, kind: 'cron', expression: record.expression, timeZone: record.timeZone }
    default:
      throw malformed('record')
  }
}

function deliveryReceipt(value: unknown): ScheduleDeliveryReceipt {
  const record = requiredRecord(value, 'delivery receipt')
  if (
    !isIsoTimestamp(record.scheduledAt) ||
    !isIsoTimestamp(record.deliveredAt) ||
    !isNonEmptyString(record.messageId)
  )
    throw malformed('delivery receipt')
  return {
    scheduledAt: record.scheduledAt,
    deliveredAt: record.deliveredAt,
    messageId: record.messageId,
  }
}

function deliveryRecord(value: unknown): ScheduleHistoryPage['records'][number] {
  const receipt = deliveryReceipt(value)
  const record = value as Record<string, unknown>
  if (record.prompt !== undefined && typeof record.prompt !== 'string') throw malformed('history record')
  return {
    ...receipt,
    ...(record.prompt === undefined ? {} : { prompt: record.prompt }),
  }
}

function historyPage(record: Record<string, unknown>): ScheduleHistoryPage {
  if (
    !Array.isArray(record.records) ||
    typeof record.earlierRecordsUnavailable !== 'boolean' ||
    typeof record.earlierRecordsPruned !== 'boolean'
  )
    throw malformed('history page')
  const retention = requiredRecord(record.retention, 'history retention')
  if (!isPositiveSafeInteger(retention.days) || !isPositiveSafeInteger(retention.records))
    throw malformed('history page')
  if (record.nextBefore !== undefined && !isNonEmptyString(record.nextBefore)) throw malformed('history page')
  return {
    id: record.id as string,
    records: record.records.map(deliveryRecord),
    earlierRecordsUnavailable: record.earlierRecordsUnavailable,
    earlierRecordsPruned: record.earlierRecordsPruned,
    retention: { days: retention.days, records: retention.records },
    ...(record.nextBefore === undefined ? {} : { nextBefore: record.nextBefore }),
  }
}

function updateResult(value: unknown, requestedId: string): ScheduleUpdateResult {
  const record = requiredRecord(value, 'update result')
  if (isScheduleToolFailure(record)) return scheduleFailure(record)
  if (record.id !== requestedId) throw malformed('update result')
  if (typeof record.updated === 'boolean') {
    const updatedRecord = scheduleRecord(record.record)
    if (updatedRecord.id !== requestedId) throw malformed('update result')
    return { id: requestedId, updated: record.updated, record: updatedRecord }
  }
  if (
    record.updated === false &&
    (record.code === 'schedule_not_found' ||
      record.code === 'schedule_ended' ||
      record.code === 'schedule_conflict')
  )
    return { id: requestedId, updated: false, code: record.code }
  return scheduleFailure(record)
}

function deleteResult(value: unknown, requestedId: string): ScheduleDeleteResult {
  const record = requiredRecord(value, 'delete result')
  if (isScheduleToolFailure(record)) return scheduleFailure(record)
  if (record.id !== requestedId) throw malformed('delete result')
  if (record.deleted === true) return { id: requestedId, deleted: true }
  if (record.deleted === false && record.code === 'schedule_not_found')
    return { id: requestedId, deleted: false, code: 'schedule_not_found' }
  return scheduleFailure(record)
}

function scheduleFailure(
  record: Record<string, unknown>,
): Extract<ScheduleMutationFailure, { readonly message: string }> {
  if (isScheduleToolFailure(record)) {
    return {
      code: record.code as Extract<ScheduleMutationFailure, { readonly message: string }>['code'],
      message: record.message,
    }
  }
  throw malformed(record.deleted === undefined ? 'update result' : 'delete result')
}

function isScheduleToolFailure(
  record: Record<string, unknown>,
): record is Record<string, unknown> & { readonly code: string; readonly message: string } {
  return (
    typeof record.code === 'string' &&
    [
      'invalid_prompt',
      'invalid_selector',
      'invalid_rule',
      'invalid_time_zone',
      'not_future',
      'time_out_of_range',
      'frequency_too_high',
      'internal_error',
    ].includes(record.code) &&
    typeof record.message === 'string'
  )
}

function toRemoteHistoryRequest(request: ScheduleHistoryRequest): Record<string, unknown> {
  return {
    sessionId: request.sessionId,
    id: request.id,
    limit: request.limit,
    ...(request.before === undefined ? {} : { before: request.before }),
  }
}

function toRemoteRecord(record: ScheduleRecord): Record<string, unknown> {
  switch (record.kind) {
    case 'at':
      return { ...record }
    case 'after':
      return { ...record }
    case 'every':
      return { ...record }
    case 'daily':
      return { ...record }
    case 'weekly':
      return { ...record, weekdays: [...record.weekdays] }
    case 'cron':
      return { ...record }
  }
}

function toRemoteTimingChange(change: ScheduleTimingChange): Record<string, unknown> {
  switch (change.kind) {
    case 'at':
      return { kind: 'at', at: toRemoteAtValue(change.at) }
    case 'every':
      return { kind: 'every', every_seconds: change.seconds }
    case 'daily':
      return {
        kind: 'daily',
        daily: { time: change.time, time_zone: change.timeZone },
      }
    case 'weekly':
      return {
        kind: 'weekly',
        weekly: { time: change.time, time_zone: change.timeZone, weekdays: [...change.weekdays] },
      }
    case 'cron':
      return {
        kind: 'cron',
        cron: { expression: change.expression, time_zone: change.timeZone },
      }
  }
}

function toRemoteAtValue(value: ScheduleAtValue): string | Record<string, string> {
  if (typeof value === 'string') return value
  const input: ScheduleAtInput = value
  return { date: input.date, time: input.time, time_zone: input.timeZone }
}

function validateHistoryRequest(request: ScheduleHistoryRequest): void {
  requireIdentifier(request.sessionId, 'Session')
  requireIdentifier(request.id, 'Schedule')
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > MAX_HISTORY_LIMIT)
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'A Schedule history page size must be between 1 and 100.',
      retryable: false,
    })
  if (request.before !== undefined) requireIdentifier(request.before, 'Schedule history cursor')
}

function validateUpdateRequest(request: ScheduleUpdateRequest): void {
  requireIdentifier(request.sessionId, 'Session')
  requireIdentifier(request.id, 'Schedule')
  if (request.expected.id !== request.id) throw malformed('update request')
  if (request.title === undefined && request.prompt === undefined && request.change === undefined)
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'A Schedule update must change its title, prompt, or timing.',
      retryable: false,
    })
  // Run the same projection validation used on a response before it crosses the RPC boundary.
  toRemoteRecord(scheduleRecord(request.expected))
  if (request.title !== undefined && typeof request.title !== 'string') throw malformed('update request')
  if (request.prompt !== undefined && typeof request.prompt !== 'string') throw malformed('update request')
}

function requireIdentifier(value: string, part: string): void {
  if (!isNonEmptyString(value))
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: `A DSH ${part} is required for this Schedule operation.`,
      retryable: false,
    })
}

function requiredRecord(value: unknown, part: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value))
    return value as Record<string, unknown>
  throw malformed(part)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isIsoTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.startsWith('0000-') ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)
  )
    return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function isWeekdays(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((weekday) => Number.isSafeInteger(weekday) && weekday >= 1 && weekday <= 7) &&
    new Set(value).size === value.length
  )
}

function malformed(part: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed rc172 Schedule ${part}.`,
    retryable: false,
  })
}
