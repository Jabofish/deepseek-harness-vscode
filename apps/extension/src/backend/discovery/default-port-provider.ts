import type { BackendCandidate } from '@dsh-vscode/domain'
import { DEFAULT_DSH_WEB_PORT } from '@dsh-vscode/dsh-adapter'

import { discoveryCancelled, type DiscoveryProvider } from './provider.js'

export class DefaultPortDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'default-port'

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted === true) return Promise.reject(discoveryCancelled(signal.reason))
    const endpoint = {
      host: '127.0.0.1' as const,
      port: DEFAULT_DSH_WEB_PORT,
      baseUrl: `http://127.0.0.1:${DEFAULT_DSH_WEB_PORT}`,
    }
    return Promise.resolve([{ endpoint, source: 'default-port', confidence: 80 }])
  }
}
