import type { BackendFactory } from '@dsh-vscode/application'
import type { ConnectedBackend, DshBackend } from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'

import type { DshVersionAdapter } from './contracts.js'

export class VersionedBackendFactory implements BackendFactory {
  public constructor(private readonly adapters: readonly DshVersionAdapter[]) {}

  public async connect(backend: ConnectedBackend, signal?: AbortSignal): Promise<DshBackend> {
    const adapter =
      this.adapters.find((candidate) => candidate.supportedVersion === backend.capabilities.dshVersion) ??
      this.adapters.find((candidate) => candidate.protocolVersion === backend.capabilities.protocolVersion) ??
      this.adapters.find((candidate) => candidate.fallback === true)
    if (adapter === undefined || adapter.createBackend === undefined) {
      throw new AppError({
        code: 'DSH_INCOMPATIBLE',
        message: `No adapter is available for DSH ${backend.capabilities.dshVersion}.`,
        retryable: false,
      })
    }
    return adapter.createBackend(backend, signal)
  }
}
