import { AppError, type SubagentHistoryPage, type SubagentHistoryQuery } from '@dsh-vscode/domain'
import type { DshTransport } from '../../contracts.js'
import type { SubagentRepositoryOptions } from '../../repositories/subagent-repository.js'
import { Alpha212SubagentRepository } from '../alpha212/subagent-repository.js'
import { unwrapRpcResultValue } from '../rc6/rpc.js'
import { rc222Identifier, parseRc222Contract } from './contracts.js'
import { z } from 'zod'
import { mapRc202ProjectionValues } from '../rc202/user-question-projections.js'
import { mapRc222PublicProjection } from './projections.js'

const interruptReceipt = z.object({ accepted: z.literal(true) }).strict()

/** Target Session authorisation is supplied by the Host and rechecked by the Gateway. */
export class Rc222SubagentRepository extends Alpha212SubagentRepository {
  public constructor(transport: DshTransport, options: SubagentRepositoryOptions) {
    super(transport, { ...options, namedCatalog: true, directChildControls: true })
  }

  public override async history(
    sessionId: string,
    query?: SubagentHistoryQuery,
    signal?: AbortSignal,
  ): Promise<SubagentHistoryPage> {
    const page = await super.history(sessionId, query, signal)
    if (page.projection === undefined) return page
    return {
      ...page,
      projection: mapRc222PublicProjection({
        ...page.projection,
        values: mapRc202ProjectionValues(page.projection.values),
      }),
    }
  }

  public override async interrupt(sessionId: string, signal?: AbortSignal): Promise<void> {
    const child = rc222Identifier.safeParse(sessionId)
    if (!child.success)
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'Invalid subagent identity.',
        retryable: false,
      })
    const method = 'subagents/interruptByUser'
    const value = unwrapRpcResultValue(
      await this.remoteTransport.remoteRequest(method, { childSessionId: child.data }, signal),
      method,
    )
    parseRc222Contract(interruptReceipt, value, method)
  }
}
