import type { BackendCandidate, ConnectedBackend } from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'

import type { BackendProbe } from '@dsh-vscode/application'
import { isKnownDshVersion, normalizeDshVersion, type DshVersionAdapter } from './contracts.js'
import { withBestEffortAdapterCapabilities, withExactAdapterCapabilities } from './compatibility.js'

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
    throwIfProbeAborted(signal)
    if (!(await this.preflight(candidate, signal))) return undefined
    throwIfProbeAborted(signal)
    const hintedVersion = normalizeDshVersion(candidate.runtimeVersion)
    const compatibilityProbe = hintedVersion !== undefined && !isKnownDshVersion(hintedVersion)
    const adapters = compatibilityProbe ? orderCompatibilityAdapters(this.adapters) : this.adapters
    let incompatible: AppError | undefined
    for (const adapter of adapters) {
      throwIfProbeAborted(signal)
      try {
        const capabilities = compatibilityProbe
          ? adapter.probeCompatibility === undefined
            ? undefined
            : await adapter.probeCompatibility(candidate, signal)
          : await adapter.probe(candidate, signal)
        throwIfProbeAborted(signal)
        if (capabilities !== undefined) {
          // A legacy adapter may already have classified an unversioned
          // candidate as best-effort. Preserve that classification instead of
          // letting the outer probe label it exact merely because no runtime
          // string was available to trigger the unknown-version branch.
          const bestEffort =
            compatibilityProbe ||
            capabilities.compatibilityMode === 'best-effort' ||
            capabilities.compatibilityWarning !== undefined
          const selectedCapabilities = bestEffort
            ? withBestEffortAdapterCapabilities(capabilities, hintedVersion, adapter.id)
            : withExactAdapterCapabilities(capabilities, adapter.id)
          return {
            endpoint: candidate.endpoint,
            ownership: 'external',
            capabilities: selectedCapabilities,
            ...(candidate.pid === undefined ? {} : { pid: candidate.pid }),
          }
        }
      } catch (error) {
        // A version-specific or compatibility probe may decline a candidate.
        // Continue with the next newest safe wire-compatible adapter unless
        // the caller cancelled the operation.
        if (
          signal?.aborted === true ||
          (error instanceof AppError && error.code === 'REQUEST_CANCELLED') ||
          (error instanceof DOMException && error.name === 'AbortError') ||
          (error instanceof Error && error.name === 'AbortError')
        )
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

function throwIfProbeAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  throw signal.reason ?? new DOMException('The DSH compatibility probe was cancelled.', 'AbortError')
}

function orderCompatibilityAdapters(adapters: readonly DshVersionAdapter[]): readonly DshVersionAdapter[] {
  return adapters
    .map((adapter, index) => ({ adapter, index }))
    .sort(
      (left, right) =>
        (right.adapter.compatibilityPriority ?? 0) - (left.adapter.compatibilityPriority ?? 0) ||
        left.index - right.index,
    )
    .map(({ adapter }) => adapter)
}

async function releasePreflightBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    /* releasing the connection is best effort */
  }
}
