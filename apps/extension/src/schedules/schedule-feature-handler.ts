import type { ScheduleUseCases } from '@dsh-vscode/application'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'

export type ScheduleFeatureRequest = Extract<
  FeatureRequest,
  {
    readonly type:
      'schedule.catalog' | 'schedule.list' | 'schedule.history' | 'schedule.update' | 'schedule.delete'
  }
>

/** Route the strict Schedule protocol payloads into application use cases. */
export async function handleScheduleFeatureRequest(
  request: ScheduleFeatureRequest,
  schedules: ScheduleUseCases,
  signal: AbortSignal,
): Promise<unknown> {
  switch (request.type) {
    case 'schedule.catalog':
      return { kind: 'schedule.catalog', items: await schedules.catalog(signal) }
    case 'schedule.list':
      return { kind: 'schedule.records', items: await schedules.list(request.payload.sessionId, signal) }
    case 'schedule.history': {
      const { before, ...historyRequest } = request.payload
      return {
        kind: 'schedule.history',
        result: await schedules.history(
          { ...historyRequest, ...(before === undefined ? {} : { before }) },
          signal,
        ),
      }
    }
    case 'schedule.update': {
      const { change, title, prompt, ...updateRequest } = request.payload
      return {
        kind: 'schedule.updated',
        result: await schedules.update(
          {
            ...updateRequest,
            ...(change === undefined ? {} : { change }),
            ...(title === undefined ? {} : { title }),
            ...(prompt === undefined ? {} : { prompt }),
          },
          signal,
        ),
      }
    }
    case 'schedule.delete':
      return {
        kind: 'schedule.deleted',
        result: await schedules.delete(request.payload.sessionId, request.payload.id, signal),
      }
  }
}
