import { AppError, type AccountBonusBatch, type AccountBonusNotification } from '@dsh-vscode/domain'
import { recordOrUndefined } from '../../repositories/shared/guards.js'
import { Alpha211AccountLifecycleRepository } from '../alpha211/account-repository.js'

/** alpha.5 AccountBonusNotification: only localized display fields are required.
 * Optional arbitrary Platform JSON stays out of Domain and the public protocol.
 */
export class Alpha215AccountLifecycleRepository extends Alpha211AccountLifecycleRepository {
  protected override readBonusBatch(value: unknown, method: string): AccountBonusBatch | null {
    if (value === null) return null
    const batch = recordOrUndefined(value)
    if (!batch || !text(batch.accountId, 256) || !Array.isArray(batch.bonuses) || batch.bonuses.length > 128)
      throw malformed(method)
    const bonuses: AccountBonusNotification[] = batch.bonuses.map((item: unknown) => {
      const notice = recordOrUndefined(item)
      if (
        !notice ||
        !text(notice.orderId, 128) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(notice.orderId) ||
        !text(notice.expiresAt, 128) ||
        !text(notice.message, 4_096) ||
        (notice.title !== undefined && !text(notice.title, 4_096))
      )
        throw malformed(method)
      return {
        orderId: notice.orderId,
        expiresAt: notice.expiresAt,
        message: notice.message,
        ...(notice.title === undefined ? {} : { title: notice.title }),
      }
    })
    return { accountId: batch.accountId, bonuses }
  }
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum
}

function malformed(method: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed account response for ${method}.`,
    retryable: false,
  })
}
