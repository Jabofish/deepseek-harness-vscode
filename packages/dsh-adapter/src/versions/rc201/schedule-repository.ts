import {
  AppError,
  type ScheduleCatalogEntry,
  type ScheduleDeleteResult,
  type ScheduleHistoryRequest,
  type ScheduleHistoryResult,
  type ScheduleRecord,
  type ScheduleUpdateRequest,
  type ScheduleUpdateResult,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../../contracts.js'
import { Rc172ScheduleRepository } from '../rc172/schedule-repository.js'

type ScheduleRemoteMethod =
  'schedule/catalog' | 'schedule/list' | 'schedule/history' | 'schedule/update' | 'schedule/delete'

/**
 * RC201 keeps the rc.2 Schedule wire, but its optional bundle can withdraw a
 * previously registered Gateway definition. rc.2's normalizer intentionally
 * maps that Gateway error to `unknown-command`; at the Schedule boundary this
 * exact error means the optional capability is currently absent.
 */
export class Rc201ScheduleRepository extends Rc172ScheduleRepository {
  public constructor(transport: DshTransport) {
    super(transport)
  }

  public override catalog(signal?: AbortSignal): Promise<readonly ScheduleCatalogEntry[]> {
    return mapUnavailableScheduleRemote('schedule/catalog', () => super.catalog(signal))
  }

  public override list(sessionId: string, signal?: AbortSignal): Promise<readonly ScheduleRecord[]> {
    return mapUnavailableScheduleRemote('schedule/list', () => super.list(sessionId, signal))
  }

  public override history(
    request: ScheduleHistoryRequest,
    signal?: AbortSignal,
  ): Promise<ScheduleHistoryResult> {
    return mapUnavailableScheduleRemote('schedule/history', () => super.history(request, signal))
  }

  public override update(
    request: ScheduleUpdateRequest,
    signal?: AbortSignal,
  ): Promise<ScheduleUpdateResult> {
    return mapUnavailableScheduleRemote('schedule/update', () => super.update(request, signal))
  }

  public override delete(sessionId: string, id: string, signal?: AbortSignal): Promise<ScheduleDeleteResult> {
    return mapUnavailableScheduleRemote('schedule/delete', () => super.delete(sessionId, id, signal))
  }
}

async function mapUnavailableScheduleRemote<T>(
  method: ScheduleRemoteMethod,
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request()
  } catch (error) {
    if (
      error instanceof AppError &&
      error.code === 'INVALID_CONFIGURATION' &&
      error.context?.rpcMethod === method &&
      error.context.rpcCode === 'unknown-command'
    ) {
      throw new AppError({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This DSH host does not expose Schedule in its current configuration.',
        retryable: false,
        context: { capability: 'schedule', rpcMethod: method, rpcCode: 'unknown-command' },
      })
    }
    throw error
  }
}
