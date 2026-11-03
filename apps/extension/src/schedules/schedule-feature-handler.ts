import type { ScheduleUseCases } from '@dsh-vscode/application'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'

export type ScheduleFeatureRequest = Extract<
  FeatureRequest,
  {
    readonly type:
      | 'schedule.catalog'
      | 'schedule.list'
      | 'schedule.history'
      | 'schedule.update'
      | 'schedule.delete'
      | 'schedule.run'
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
      const { before, sessionId, ...historyRequest } = request.payload
      return {
        kind: 'schedule.history',
        result: await schedules.history(
          {
            ...historyRequest,
            ...(before === undefined ? {} : { before }),
            ...(sessionId === undefined ? {} : { sessionId }),
          },
          signal,
        ),
      }
    }
    case 'schedule.update': {
      const { change, title, prompt, sessionId, expectedUpdatedAt, active, ...updateRequest } =
        request.payload
      return {
        kind: 'schedule.updated',
        result: await schedules.update(
          {
            ...updateRequest,
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
            ...(active === undefined ? {} : { active }),
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
        result: await schedules.delete(
          request.payload.sessionId,
          request.payload.id,
          signal,
          request.payload.expectedUpdatedAt,
        ),
      }
    case 'schedule.run':
      return { kind: 'schedule.ran', result: await schedules.run(request.payload.id, signal) }
  }
}
