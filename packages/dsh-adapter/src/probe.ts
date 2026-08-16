import type { BackendCandidate, ConnectedBackend } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { BackendProbe } from '@dsh-vscode/application'
import type { DshVersionAdapter } from './contracts.js'

export class VersionedBackendProbe implements BackendProbe {
  public constructor(private readonly adapters: readonly DshVersionAdapter[]) {}

  public probe(candidate: BackendCandidate, signal?: AbortSignal): Promise<ConnectedBackend | undefined> {
    return unimplemented<Promise<ConnectedBackend | undefined>>('versioned DSH backend probe', [
      'enforce loopback host and valid port before any network request',
      'use a short health and capability timeout',
      'select exactly one adapter from the server-reported DSH/protocol version',
      'return undefined for unrelated or unreachable local services',
      'return an explicit incompatible-version error for confirmed unsupported DSH servers',
      'mark every discovered backend as externally owned',
      `candidate ${candidate.endpoint.baseUrl}; adapters ${this.adapters.map((adapter) => adapter.id).join(', ')}; signal present ${String(signal !== undefined)}`,
    ])
  }
}
