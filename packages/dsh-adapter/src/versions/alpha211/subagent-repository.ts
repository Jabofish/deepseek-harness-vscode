import { AppError } from '@dsh-vscode/domain'
import type { DshTransport } from '../../contracts.js'
import {
  Rc6SubagentRepository,
  type SubagentRepositoryOptions,
} from '../../repositories/subagent-repository.js'
import { recordOrUndefined } from '../../repositories/shared/guards.js'
import { unwrapRpcResultValue, callRpc } from '../rc6/rpc.js'
import { validAlpha171ProjectionBaseline } from '../alpha171/session-wire.js'

/** alpha.1 publishes child discovery via session/projections, not subagents/list. */
export class Alpha211SubagentRepository extends Rc6SubagentRepository {
  public constructor(
    protected readonly remoteTransport: DshTransport,
    private readonly catalogOptions: SubagentRepositoryOptions = {},
  ) {
    super(remoteTransport, catalogOptions)
  }

  protected override async readCatalog(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    const values = await this.projections(sessionId, signal)
    const catalog = catalogEntries(values, this.catalogOptions.externalCatalog === true)
    const list = recordOrUndefined(await callRpc<unknown>(this.remoteTransport, 'session.list', {}, signal))
    if (!Array.isArray(list?.items)) throw malformed()
    const sessions = new Map(
      list.items.map((item) => {
        const row = recordOrUndefined(item)
        if (
          typeof row?.sessionId !== 'string' ||
          typeof row.agentAvailable !== 'boolean' ||
          typeof row.running !== 'boolean'
        )
          throw malformed()
        return [row.sessionId, row] as const
      }),
    )
    // Bound independent child observations; an external execution has no Session to query.
    const entries: unknown[] = new Array(catalog.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < catalog.length) {
        signal?.throwIfAborted()
        const index = next++
        const child = catalog[index]!
        if (child.mode === 'unknown') {
          entries[index] = { kind: 'diagnostic', id: child.id, reason: 'unsupported' }
          continue
        }
        let hasChildren = false
        if (child.mode !== 'external') {
          try {
            hasChildren =
              catalogEntries(
                await this.projections(child.id as string, signal),
                this.catalogOptions.externalCatalog === true,
              ).length > 0
          } catch (error) {
            if (signal?.aborted === true || (error instanceof AppError && error.code === 'REQUEST_CANCELLED'))
              throw error
            entries[index] = {
              kind: 'diagnostic',
              id: child.id,
              reason:
                error instanceof AppError && error.code === 'PROTOCOL_ERROR' ? 'corrupt' : 'unavailable',
            }
            continue
          }
        }
        entries[index] = {
          kind: 'child',
          id: child.id,
          mode: child.mode,
          ...(child.label === undefined ? {} : { label: child.label }),
          hasChildren,
          activity:
            child.mode !== 'external' && sessions.get(child.id as string)?.running === true
              ? 'running'
              : 'inactive',
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(catalog.length, 4) }, () => worker()))
    signal?.throwIfAborted()
    return { entries, parentAvailable: sessions.get(sessionId)?.agentAvailable === true }
  }

  protected async projections(
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
    if (!validAlpha171ProjectionBaseline(value)) throw malformed()
    return value.values as Readonly<Record<string, unknown>>
  }
}

function catalogEntries(
  values: Readonly<Record<string, unknown>>,
  externalCatalog: boolean,
): readonly Record<string, unknown>[] {
  if (values.subagentCatalog === undefined) return []
  if (!Array.isArray(values.subagentCatalog) || values.subagentCatalog.length > 5_000) throw malformed()
  const seen = new Set<string>()
  return values.subagentCatalog.map((item) => {
    const entry = recordOrUndefined(item)
    if (
      entry === undefined ||
      typeof entry.id !== 'string' ||
      entry.id.trim() === '' ||
      seen.has(entry.id) ||
      typeof entry.createdAt !== 'number' ||
      !Number.isSafeInteger(entry.createdAt) ||
      entry.createdAt < 0 ||
      (!['one-shot', 'continuable', 'unknown'].includes(String(entry.mode)) &&
        !(externalCatalog && entry.mode === 'external')) ||
      (entry.label !== undefined && typeof entry.label !== 'string') ||
      (entry.mode === 'continuable' && typeof entry.label !== 'string')
    )
      throw malformed()
    seen.add(entry.id)
    return entry
  })
}

function malformed(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed subagent projection.',
    retryable: false,
  })
}
