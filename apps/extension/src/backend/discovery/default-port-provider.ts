import type { BackendCandidate } from '@dsh-vscode/domain'

import { discoveryCancelled, type DiscoveryProvider } from './provider.js'

export class DefaultPortDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'default-port'

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted === true) return Promise.reject(discoveryCancelled(signal.reason))
    return Promise.resolve([
      {
        endpoint: { host: '127.0.0.1', port: 3080, baseUrl: 'http://127.0.0.1:3080' },
        source: 'default-port',
        confidence: 80,
      },
    ])
  }
}
