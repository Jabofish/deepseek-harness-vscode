import type {
  ScheduleCatalogEntry,
  ScheduleDeleteResult,
  ScheduleHistoryRequest,
  ScheduleHistoryResult,
  ScheduleRecord,
  ScheduleRepository,
  ScheduleUpdateRequest,
  ScheduleUpdateResult,
} from '@dsh-vscode/domain'

/** Application boundary for the Host-owned Schedule Remote. */
export class ScheduleUseCases {
  public constructor(private readonly schedules: ScheduleRepository) {}

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

  public delete(sessionId: string, id: string, signal?: AbortSignal): Promise<ScheduleDeleteResult> {
    return this.schedules.delete(sessionId, id, signal)
  }
}
