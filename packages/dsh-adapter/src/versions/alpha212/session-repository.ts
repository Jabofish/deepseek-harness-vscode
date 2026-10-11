import { AppError, type SessionDetail, type SessionSummary } from '@dsh-vscode/domain'

import { recordOrUndefined } from '../../repositories/shared/guards.js'
import { requiredRecord, requiredSessionId } from '../../repositories/session/responses.js'
import { unwrapRpcResultValue } from '../rc6/rpc.js'
import { Rc172SessionRepository } from '../rc172/session-repository.js'

/** Cold stored Sessions must be opened deliberately before migration and fork. */
export class Alpha212SessionRepository extends Rc172SessionRepository {
  public override async get(sessionId: string, signal?: AbortSignal): Promise<SessionDetail> {
    // A successfully decoded V4 history is authoritative after an explicit open.
    return { ...(await super.get(sessionId, signal)), formatStatus: 'current' }
  }

  protected override mapSessionSummary(value: unknown): SessionSummary {
    const summary = super.mapSessionSummary(value)
    const status = recordOrUndefined(value)?.formatStatus
    if (status !== undefined && status !== 'current' && status !== 'migration-required')
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: 'DSH returned an invalid session format status.',
        retryable: false,
      })
    return { ...summary, ...(status === undefined ? {} : { formatStatus: status }) }
  }

  public override async fork(
    sessionId: string,
    atSeq?: number,
    signal?: AbortSignal,
  ): Promise<SessionDetail> {
    let value: unknown
    try {
      value = unwrapRpcResultValue(
        await this.remoteTransport.remoteRequest(
          'session/fork',
          {
            request: { sessionId, allowMigration: false, ...(atSeq === undefined ? {} : { atSeq }) },
          },
          signal,
        ),
        'session/fork',
      )
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.context?.rpcCode === 'session/migration-required' ||
          error.context?.wireCode === 'session/migration-required')
      )
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'Open the original session to migrate it before forking.',
          retryable: false,
        })
      throw error
    }
    return this.get(requiredSessionId(requiredRecord(value, 'session fork'), 'session fork'), signal)
  }
}
