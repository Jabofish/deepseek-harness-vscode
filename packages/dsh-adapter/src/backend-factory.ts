import type { BackendFactory } from '@dsh-vscode/application'
import type { ConnectedBackend, DshBackend } from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'

import type { DshVersionAdapter } from './contracts.js'

export class VersionedBackendFactory implements BackendFactory {
  public constructor(private readonly adapters: readonly DshVersionAdapter[]) {}

  public async connect(backend: ConnectedBackend, signal?: AbortSignal): Promise<DshBackend> {
    const adapter = selectAdapter(this.adapters, backend)
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

function selectAdapter(
  adapters: readonly DshVersionAdapter[],
  backend: ConnectedBackend,
): DshVersionAdapter | undefined {
  // The probe result is authoritative. In best-effort mode, falling back to a
  // shared protocol id would silently replace the implementation that passed
  // the read-only compatibility check.
  if (backend.capabilities.compatibilityMode === 'best-effort') {
    if (backend.capabilities.adapterId === undefined) return undefined
    return adapters.find((candidate) => candidate.id === backend.capabilities.adapterId)
  }
  if (backend.capabilities.adapterId !== undefined) {
    return adapters.find((candidate) => candidate.id === backend.capabilities.adapterId)
  }
  return (
    adapters.find((candidate) => candidate.supportedVersion === backend.capabilities.dshVersion) ??
    adapters.find((candidate) => candidate.protocolVersion === backend.capabilities.protocolVersion) ??
    adapters.find((candidate) => candidate.fallback === true)
  )
}
