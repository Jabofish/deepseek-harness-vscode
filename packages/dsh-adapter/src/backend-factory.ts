import type { BackendFactory } from '@dsh-vscode/application'
import type { ConnectedBackend, DshBackend } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DshVersionAdapter } from './contracts.js'

export class VersionedBackendFactory implements BackendFactory {
  public constructor(private readonly adapters: readonly DshVersionAdapter[]) {}

  public connect(backend: ConnectedBackend, signal?: AbortSignal): Promise<DshBackend> {
    return unimplemented<Promise<DshBackend>>('compose a connected versioned DSH backend', [
      'select the adapter matching probed capabilities',
      'construct one shared transport, stream controller, and every repository',
      'ensure close disposes the graph exactly once',
      'never allow rc6 wire values to escape as domain types',
      `backend ${backend.endpoint.baseUrl}; adapters ${this.adapters.length}; signal present ${String(signal !== undefined)}`,
    ])
  }
}
