import type { BackendDiscovery } from '@dsh-vscode/application'
import type { BackendCandidate } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DiscoveryProvider } from './provider.js'

export class CompositeInstanceDiscovery implements BackendDiscovery {
  public constructor(private readonly providers: readonly DiscoveryProvider[]) {}

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    return unimplemented<Promise<readonly BackendCandidate[]>>(
      'parallel DSH instance discovery and ranking',
      [
        'run eligible providers concurrently under one bounded deadline',
        'isolate provider failures and cancellation',
        'deduplicate by normalized host and port while retaining strongest metadata',
        'rank configured, known, default, companion, and process candidates deterministically',
        'never scan arbitrary port ranges',
        `providers ${this.providers.map((provider) => provider.id).join(', ')}; signal present ${String(signal !== undefined)}`,
      ],
    )
  }
}
