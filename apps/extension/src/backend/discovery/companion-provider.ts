import type { BackendCandidate } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DiscoveryProvider } from './provider.js'

export class CompanionRegistryDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'companion-registry'

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    return unimplemented<Promise<readonly BackendCandidate[]>>(
      'optional DSH companion instance registry discovery',
      [
        'read only the documented user-scoped registry written by a future DSH companion integration',
        'validate owner, permissions, schema version, pid, timestamp, loopback host, and port',
        'treat registry entries as hints that still require protocol verification',
        'work correctly when no companion integration exists',
        `signal present ${String(signal !== undefined)}`,
      ],
    )
  }
}
