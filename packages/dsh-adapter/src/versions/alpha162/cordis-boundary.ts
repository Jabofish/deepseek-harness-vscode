import { AppError } from '@dsh-vscode/domain'
import { recordOrUndefined } from '../../repositories/shared/guards.js'

type PendingRun = { readonly requestId: string; readonly sessionId: string }

/** The VS Code client does not host Cordis browser code. Never pretend it ran. */
export class CordisClientBoundary {
  private readonly runs = new Map<string, PendingRun>()

  public map(event: unknown, args: readonly unknown[]): readonly unknown[] | undefined {
    if (event === 'cordis/request-run') {
      const request = recordOrUndefined(args[0])
      if (args.length !== 1 || !nonempty(request?.requestId) || !nonempty(request?.agentId)) throw malformed()
      const rpcId = `cordis-run:${request.requestId}`
      this.runs.set(rpcId, { requestId: request.requestId, sessionId: request.agentId })
      return [
        {
          type: 'host/cordis-client-required',
          rpcId,
          sessionId: request.agentId,
          approvalId: rpcId,
        },
      ]
    }
    if (event === 'cordis/request-run-resolved') {
      const resolved = recordOrUndefined(args[0])
      if (
        args.length !== 1 ||
        !nonempty(resolved?.requestId) ||
        typeof resolved.outcome !== 'string' ||
        !['approved', 'completed', 'rejected', 'cancelled', 'failed'].includes(resolved.outcome)
      )
        throw malformed()
      const rpcId = `cordis-run:${resolved.requestId}`
      const pending = this.runs.get(rpcId)
      this.runs.delete(rpcId)
      return pending === undefined
        ? []
        : [
            {
              type: 'approval/resolved',
              sessionId: pending.sessionId,
              approvalId: rpcId,
              outcome:
                resolved.outcome === 'rejected'
                  ? 'rejected'
                  : resolved.outcome === 'approved' || resolved.outcome === 'completed'
                    ? 'allowed-once'
                    : 'cancelled',
            },
          ]
    }
    if (event === 'cordis/inspect-query') {
      const request = recordOrUndefined(args[0])
      if (args.length !== 1 || !nonempty(request?.requestId) || !nonempty(request?.agentId)) throw malformed()
      // The upstream accepts only successful Client-provider answers. A made-up
      // refusal would leave the tool waiting, so expose the actual recovery path.
      return [
        {
          type: 'host/agent-error',
          sessionId: request.agentId,
          message:
            'This Cordis query needs a connected DSH Web page. Open DSH Web to handle it, or stop this turn. VS Code cannot answer browser-runtime queries.',
        },
      ]
    }
    if (event === 'api-session/removed' && typeof args[0] === 'string')
      for (const [id, run] of this.runs) if (run.sessionId === args[0]) this.runs.delete(id)
    return undefined
  }

  public async respond(
    rpcId: string,
    result: unknown,
    resolve: (requestId: string, signal?: AbortSignal) => Promise<unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const pending = this.runs.get(rpcId)
    if (pending === undefined) return undefined
    const response = recordOrUndefined(result)
    const value = recordOrUndefined(response?.value)
    if (response?.ok !== true || value?.outcome !== 'rejected' || value.sessionId !== pending.sessionId)
      throw new AppError({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'Dynamic Cordis client execution requires DSH Web. Only rejection is available here.',
        retryable: false,
      })
    const receipt = recordOrUndefined(await resolve(pending.requestId, signal))
    if (typeof receipt?.accepted !== 'boolean') throw malformed()
    this.runs.delete(rpcId)
    if (!receipt.accepted)
      throw new AppError({
        code: 'STALE_INTERACTION',
        message: 'The Cordis run request is no longer pending.',
        retryable: false,
      })
    return { accepted: true }
  }

  public clear(): void {
    this.runs.clear()
  }
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function malformed(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed Cordis interaction.',
    retryable: false,
  })
}
