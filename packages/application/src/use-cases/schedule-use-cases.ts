import type {
  ScheduleCatalogEntry,
  ScheduleDeleteResult,
  ScheduleHistoryRequest,
  ScheduleHistoryResult,
  ScheduleRecord,
  ScheduleRepository,
  ScheduleUpdateRequest,
  ScheduleUpdateResult,
  ScheduleCreateRequest,
  ScheduleRunResult,
} from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'

/** Application boundary for the Host-owned Schedule Remote. */
export class ScheduleUseCases {
  public constructor(private readonly schedules: ScheduleRepository) {}

  public create(request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleCatalogEntry> {
    if (this.schedules.create === undefined) throw unavailable()
    return this.schedules.create(request, signal)
  }

  public run(id: string, signal?: AbortSignal): Promise<ScheduleRunResult> {
    if (this.schedules.run === undefined) throw unavailable()
    return this.schedules.run(id, signal)
  }

  public catalog(signal?: AbortSignal): Promise<readonly ScheduleCatalogEntry[]> {
    return this.schedules.catalog(signal)
  }

  public list(sessionId: string, signal?: AbortSignal): Promise<readonly ScheduleRecord[]> {
    return this.schedules.list(sessionId, signal)
  }

  public history(request: ScheduleHistoryRequest, signal?: AbortSignal): Promise<ScheduleHistoryResult> {
    return this.schedules.history(request, signal)
  }

  public update(request: ScheduleUpdateRequest, signal?: AbortSignal): Promise<ScheduleUpdateResult> {
    return this.schedules.update(request, signal)
  }

  public delete(
    sessionId: string | undefined,
    id: string,
    signal?: AbortSignal,
    expectedUpdatedAt?: string | null,
  ): Promise<ScheduleDeleteResult> {
    return expectedUpdatedAt === undefined
      ? this.schedules.delete(sessionId, id, signal)
      : this.schedules.delete(sessionId, id, signal, expectedUpdatedAt)
  }
}

function unavailable(): AppError {
  return new AppError({
    code: 'CAPABILITY_UNAVAILABLE',
    message: 'This DSH version does not expose native Schedule management.',
    retryable: false,
  })
}
