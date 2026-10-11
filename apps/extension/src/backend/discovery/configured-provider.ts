import { parseServerOrigin, isLoopbackEndpoint, type BackendCandidate } from '@dsh-vscode/domain'

import { discoveryCancelled, type DiscoveryProvider } from './provider.js'

export class ConfiguredPortDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'configured-ports'

  public constructor(
    private readonly ports: () => readonly number[],
    private readonly serverUrl: () => string | undefined = () => undefined,
  ) {}

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted === true) return Promise.reject(discoveryCancelled(signal.reason))
    const unique = [...new Set(this.ports())].filter(
      (port) => Number.isInteger(port) && port >= 1 && port <= 65535,
    )
    const candidates = unique.map((port): BackendCandidate => ({
      endpoint: { host: '127.0.0.1', port, baseUrl: `http://127.0.0.1:${port}` },
      source: 'configured',
      confidence: 100,
    }))
    const url = this.serverUrl()
    if (url !== undefined) {
      const origin = parseServerOrigin(url)
      if (origin !== undefined && isLoopbackEndpoint(origin)) {
        candidates.unshift({
          endpoint: { host: origin.host, port: origin.port, baseUrl: origin.baseUrl },
          source: 'configured',
          confidence: 110,
        })
      }
    }
    return Promise.resolve(candidates)
  }
}
