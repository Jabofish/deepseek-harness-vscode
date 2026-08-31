import type { BackendCandidate, ConnectedBackend } from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'

import type { BackendProbe } from '@dsh-vscode/application'
import type { DshVersionAdapter } from './contracts.js'

export interface VersionedBackendProbeOptions {
  /**
   * Transport for the per-candidate reachability pre-flight. Without it every
   * adapter probe runs its own retry loop, so a closed loopback port costs the
   * whole adapter chain before the caller learns the endpoint is dead.
   */
  readonly fetch?: typeof globalThis.fetch
  readonly preflightTimeoutMs?: number
}

export class VersionedBackendProbe implements BackendProbe {
  public constructor(
    private readonly adapters: readonly DshVersionAdapter[],
    private readonly options: VersionedBackendProbeOptions = {},
  ) {}

  public probe(candidate: BackendCandidate, signal?: AbortSignal): Promise<ConnectedBackend | undefined> {
    if (
      (candidate.endpoint.host !== '127.0.0.1' && candidate.endpoint.host !== 'localhost') ||
      !Number.isInteger(candidate.endpoint.port) ||
      candidate.endpoint.port < 1 ||
      candidate.endpoint.port > 65_535
    ) {
      return Promise.reject(
        new AppError({
          code: 'INVALID_ENDPOINT',
          message: 'Only loopback DSH endpoints are allowed.',
          retryable: false,
        }),
      )
    }
    return this.probeAdapters(candidate, signal)
  }

  private async probeAdapters(
    candidate: BackendCandidate,
    signal?: AbortSignal,
  ): Promise<ConnectedBackend | undefined> {
    if (!(await this.preflight(candidate, signal))) return undefined
    let incompatible: AppError | undefined
    for (const adapter of this.adapters) {
      try {
        const capabilities = await adapter.probe(candidate, signal)
        if (capabilities !== undefined) {
          return {
            endpoint: candidate.endpoint,
            ownership: 'external',
            capabilities,
            ...(candidate.pid === undefined ? {} : { pid: candidate.pid }),
          }
        }
      } catch (error) {
        // A version-specific probe may decline a candidate. Continue with the
        // legacy/fallback adapter unless the caller cancelled the operation.
        if (signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError'))
          throw error
        // An endpoint that answered the pinned DSH handshake but reported no
        // compatible host version is a DSH, not an unreachable service. Keep
        // the classification, let later adapters try, and fail with it when
        // none of them accepts the candidate.
        if (error instanceof AppError && error.code === 'DSH_INCOMPATIBLE' && incompatible === undefined)
          incompatible = error
      }
    }
    if (incompatible !== undefined) throw incompatible
    return undefined
  }

  /**
   * One cheap reachability check per candidate. A loopback port that refuses
   * connections, or that never completes an HTTP exchange, cannot satisfy any
   * adapter, so the chain is skipped and the candidate is declined with the
   * same `undefined` contract the adapter loop would produce. Any endpoint
   * that does answer — any status, DSH or not — still goes through the full
   * adapter chain, and only the caller's own cancellation propagates as a
   * rejection.
   */
  private async preflight(candidate: BackendCandidate, signal?: AbortSignal): Promise<boolean> {
    const preflightFetch = this.options.fetch
    if (preflightFetch === undefined) return true
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), this.options.preflightTimeoutMs ?? 2_000)
    try {
      const response = await preflightFetch(candidate.endpoint.baseUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal]),
      })
      await releasePreflightBody(response)
      return true
    } catch (error) {
      if (signal?.aborted === true) throw error
      return false
    } finally {
      clearTimeout(timer)
    }
  }
}

async function releasePreflightBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    /* releasing the connection is best effort */
  }
}
