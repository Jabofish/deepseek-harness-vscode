import { AppError } from '@dsh-vscode/domain'
import type { DshTransport } from '../../contracts.js'
import type { SubagentRepositoryOptions } from '../../repositories/subagent-repository.js'
import { recordOrUndefined } from '../../repositories/shared/guards.js'
import { unwrapRpcResultValue } from '../rc6/rpc.js'
import { validAlpha171ProjectionBaseline } from '../alpha171/session-wire.js'
import { isJsonLike } from '../alpha/remote-mux.js'
import { Alpha211SubagentRepository } from '../alpha211/subagent-repository.js'

/** Exact alpha.2 sequenced/migration-required projection union. */
export class Alpha212SubagentRepository extends Alpha211SubagentRepository {
  public constructor(transport: DshTransport, options: SubagentRepositoryOptions) {
    super(transport, { ...options, externalCatalog: true })
  }

  protected override async projections(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> {
    const value = unwrapRpcResultValue<unknown>(
      await this.remoteTransport.remoteRequest('session/projections', { request: { sessionId } }, signal),
      'session/projections',
    )
    if (value === null)
      throw new AppError({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'The requested subagent catalog is unavailable.',
        retryable: false,
      })
    const projection = recordOrUndefined(value)
    if (projection?.kind === 'migration-required') {
      if (
        Object.keys(projection).length !== 2 ||
        recordOrUndefined(projection.values) === undefined ||
        !isJsonLike(projection.values)
      )
        throw malformed()
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'Open the original session to migrate it before reading its subagents.',
        retryable: false,
      })
    }
    if (projection?.kind !== 'sequenced') throw malformed()
    const { kind, ...baseline } = projection
    void kind
    if (!validAlpha171ProjectionBaseline(baseline)) throw malformed()
    return baseline.values as Readonly<Record<string, unknown>>
  }
}

function malformed(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed subagent projection.',
    retryable: false,
  })
}
