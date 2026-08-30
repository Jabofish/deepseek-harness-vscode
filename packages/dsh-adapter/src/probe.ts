import type { BackendCandidate, ConnectedBackend } from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'

import type { BackendProbe } from '@dsh-vscode/application'
import type { DshVersionAdapter } from './contracts.js'

export class VersionedBackendProbe implements BackendProbe {
  public constructor(private readonly adapters: readonly DshVersionAdapter[]) {}

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
}
