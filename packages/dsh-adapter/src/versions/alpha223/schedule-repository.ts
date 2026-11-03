import {
  AppError,
  SCHEDULE_INPUT_ERROR_CODES,
  type ScheduleCatalogEntry,
  type ScheduleCreateRequest,
  type ScheduleCreateTiming,
  type ScheduleDeleteResult,
  type ScheduleHistoryRequest,
  type ScheduleHistoryResult,
  type ScheduleRecord,
  type ScheduleRepository,
  type ScheduleRunResult,
  type ScheduleUpdateRequest,
  type ScheduleUpdateResult,
} from '@dsh-vscode/domain'
import type { DshTransport } from '../../contracts.js'
import { Alpha223ScheduleClient } from './schedule-client.js'
import type { parseAlpha223ScheduleCreate } from './schedule-contract.js'

type NativeEntry = ReturnType<typeof parseAlpha223ScheduleCreate>

/** dsh-v0.2.2-alpha.3 / 05b1cae8: Host tasks, explicit revisions and safe target DTOs. */
export class Alpha223ScheduleRepository implements ScheduleRepository {
  public readonly management = 'host' as const
  private readonly client: Alpha223ScheduleClient
  public constructor(transport: DshTransport) {
    this.client = new Alpha223ScheduleClient(transport)
  }

  public async catalog(signal?: AbortSignal): Promise<readonly ScheduleCatalogEntry[]> {
    return (await this.client.catalog(signal)).map(catalogEntry)
  }
  public async list(sessionId: string, signal?: AbortSignal): Promise<readonly ScheduleRecord[]> {
    if (sessionId.trim() === '') throw invalid()
    return (await this.client.catalog(signal))
      .filter(
        (entry) =>
          entry.status === 'active' &&
          entry.target.kind === 'session' &&
          entry.target.sessionId === sessionId,
      )
      .map(rule)
  }
  public async history(
    request: ScheduleHistoryRequest,
    signal?: AbortSignal,
  ): Promise<ScheduleHistoryResult> {
    const result = await this.client.history(
      {
        id: request.id,
        limit: request.limit,
        ...(request.before === undefined ? {} : { before: request.before }),
      },
      signal,
    )
    if ('code' in result) return result
    return {
      id: result.id,
      earlierRecordsUnavailable: result.earlierRecordsUnavailable,
      earlierRecordsPruned: result.earlierRecordsPruned,
      retention: result.retention,
      ...(result.nextBefore === undefined ? {} : { nextBefore: result.nextBefore }),
      records: result.records.map(({ prompt, ...record }) => ({
        ...record,
        ...(prompt === undefined ? {} : { prompt }),
      })),
    }
  }
  public async create(request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleCatalogEntry> {
    if (request.workingDirectory.trim() === '') throw invalid()
    return catalogEntry(
      await this.client.create(
        {
          title: request.title,
          prompt: request.prompt,
          timing: remoteTiming(request.timing),
          target: { kind: request.targetMode, create: { cwd: request.workingDirectory } },
        },
        signal,
      ),
    )
  }
  public async update(request: ScheduleUpdateRequest, signal?: AbortSignal): Promise<ScheduleUpdateResult> {
    try {
      return await this.edit(request, signal)
    } catch (error) {
      const reason =
        error instanceof AppError
          ? SCHEDULE_INPUT_ERROR_CODES.find((value) => value === error.context?.scheduleReason)
          : undefined
      if (reason !== undefined) return { code: reason, message: 'DSH rejected the Schedule input.' }
      throw error
    }
  }
  private async edit(request: ScheduleUpdateRequest, signal?: AbortSignal): Promise<ScheduleUpdateResult> {
    if (request.id !== request.expected.id || request.expectedUpdatedAt === undefined) throw invalid()
    const result = await this.client.edit(
      {
        id: request.id,
        action: 'update',
        expectedUpdatedAt: request.expectedUpdatedAt,
        patch: {
          ...(request.title === undefined ? {} : { title: request.title }),
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
          ...(request.change === undefined ? {} : { timing: remoteTiming(request.change) }),
          ...(request.active === undefined ? {} : { active: request.active }),
        },
      },
      signal,
    )
    if ('kind' in result) return { id: request.id, updated: true, record: rule(result) }
    if ('code' in result) return { id: request.id, updated: false, code: result.code }
    throw invalid()
  }
  public async delete(
    _sessionId: string | undefined,
    id: string,
    signal?: AbortSignal,
    expectedUpdatedAt?: string | null,
  ): Promise<ScheduleDeleteResult> {
    if (expectedUpdatedAt === undefined) throw invalid()
    const result = await this.client.edit({ id, action: 'delete', expectedUpdatedAt }, signal)
    if ('deleted' in result) return { id, deleted: true }
    if ('code' in result) return { id, deleted: false, code: result.code }
    throw invalid()
  }
  public async run(id: string, signal?: AbortSignal): Promise<ScheduleRunResult> {
    try {
      const result = await this.client.run({ id }, signal)
      return 'kind' in result ? { id, admitted: true } : { id, admitted: false, code: result.code }
    } catch (error) {
      if (error instanceof AppError && error.context?.scheduleReason === 'target-archived')
        return { id, admitted: false, code: 'schedule_target_archived' }
      throw error
    }
  }
}

function catalogEntry(entry: NativeEntry): ScheduleCatalogEntry {
  const target = entry.target
  const agentPreset = target.kind === 'session' ? undefined : target.create.agentPreset
  const directory = target.kind === 'session' ? undefined : target.create.cwd
  return {
    ...rule(entry),
    status: entry.status,
    ...(target.kind === 'session'
      ? { sessionId: target.sessionId, target: { kind: 'session' as const, sessionId: target.sessionId } }
      : {
          target: {
            ...(target.kind === 'new_once'
              ? { kind: 'new_once' as const, sessionId: target.sessionId }
              : { kind: 'new' as const }),
            ...(agentPreset === undefined ? {} : { agentPreset }),
          },
        }),
    ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
    ...(entry.lastDelivery === undefined ? {} : { lastDelivery: entry.lastDelivery }),
    involvedSessionIds: entry.involvedSessionIds,
    ...(directory === undefined ? {} : { targetWorkingDirectory: directory }),
  }
}
function rule(entry: NativeEntry): ScheduleRecord {
  const common = { id: entry.id, title: entry.title, prompt: entry.prompt, scheduledAt: entry.scheduledAt }
  switch (entry.kind) {
    case 'at':
      return { ...common, kind: 'at' }
    case 'after':
      return { ...common, kind: 'after', afterSeconds: entry.afterSeconds }
    case 'every':
      return { ...common, kind: 'every', everySeconds: entry.everySeconds }
    case 'daily':
      return { ...common, kind: 'daily', time: entry.time, timeZone: entry.timeZone }
    case 'weekly':
      return {
        ...common,
        kind: 'weekly',
        time: entry.time,
        timeZone: entry.timeZone,
        weekdays: entry.weekdays,
      }
    case 'cron':
      return { ...common, kind: 'cron', expression: entry.expression, timeZone: entry.timeZone }
    case 'rrule':
      return { ...common, kind: 'rrule', rrule: entry.rrule }
  }
}
function remoteTiming(
  timing: ScheduleCreateTiming,
): Parameters<Alpha223ScheduleClient['create']>[0]['timing'] {
  switch (timing.kind) {
    case 'after':
      return { kind: 'after', after_seconds: timing.seconds }
    case 'every':
      return { kind: 'every', every_seconds: timing.seconds }
    case 'at':
      return {
        kind: 'at',
        at:
          typeof timing.at === 'string'
            ? timing.at
            : { date: timing.at.date, time: timing.at.time, time_zone: timing.at.timeZone },
      }
    case 'daily':
      return { kind: 'daily', daily: { time: timing.time, time_zone: timing.timeZone } }
    case 'weekly':
      return {
        kind: 'weekly',
        weekly: { time: timing.time, time_zone: timing.timeZone, weekdays: [...timing.weekdays] },
      }
    case 'cron':
      return { kind: 'cron', cron: { expression: timing.expression, time_zone: timing.timeZone } }
    case 'rrule':
      return { kind: 'rrule', rrule: timing.rrule }
  }
}
function invalid(): AppError {
  return new AppError({
    code: 'INVALID_CONFIGURATION',
    message: 'Invalid Schedule request or missing edit revision.',
    retryable: false,
  })
}
