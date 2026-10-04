import { AppError, type ScheduleUpdateResult } from '@dsh-vscode/domain'

import { Rc201ScheduleRepository } from '../rc201/schedule-repository.js'

/** alpha.1 refuses updates bound to delegated Sessions, without mutating the task. */
export class Alpha211ScheduleRepository extends Rc201ScheduleRepository {
  protected override mapUpdateResult(value: unknown, requestedId: string): ScheduleUpdateResult {
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      'code' in value &&
      value.code === 'subagent_session'
    ) {
      if (
        !('message' in value) ||
        typeof value.message !== 'string' ||
        value.message.trim() === '' ||
        value.message.length > 2_000
      ) {
        throw new AppError({
          code: 'PROTOCOL_ERROR',
          message: 'DSH returned a malformed Schedule refusal.',
          retryable: false,
        })
      }
      return { code: 'subagent_session', message: value.message }
    }
    return super.mapUpdateResult(value, requestedId)
  }
}
