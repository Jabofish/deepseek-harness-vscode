import { AppError, type BillingUsagePage } from '@dsh-vscode/domain'
import { Alpha212SessionRepository } from '../alpha212/session-repository.js'
import { rc213BillingPage } from './billing.js'
import { callRpc } from '../rc6/rpc.js'
import { recordOrUndefined } from '../../repositories/shared/guards.js'

/** Accounting reads share the exact transport and lifetime, never the UI reducer. */
export class Rc213SessionRepository extends Alpha212SessionRepository {
  public async readBillingPage(
    sessionId: string,
    beforeSequence?: number,
    signal?: AbortSignal,
  ): Promise<BillingUsagePage> {
    signal?.throwIfAborted()
    const value = recordOrUndefined(
      await callRpc<unknown>(
        this.remoteTransport,
        'session.history',
        {
          sessionId,
          maxMessages: 500,
          ...(beforeSequence === undefined ? {} : { beforeSeq: beforeSequence }),
        },
        signal,
      ),
    )
    signal?.throwIfAborted()
    if (value === undefined || !Array.isArray(value.events) || typeof value.hasMore !== 'boolean')
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: 'Invalid accounting history response.',
        retryable: false,
      })
    return rc213BillingPage(value.events, value.hasMore)
  }
}
