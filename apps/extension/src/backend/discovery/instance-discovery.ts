import type { BackendDiscovery } from '@dsh-vscode/application'
import type { BackendCandidate } from '@dsh-vscode/domain'

import { discoveryCancelled, type DiscoveryProvider } from './provider.js'

export class CompositeInstanceDiscovery implements BackendDiscovery {
  public constructor(private readonly providers: readonly DiscoveryProvider[]) {}

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted === true) return Promise.reject(discoveryCancelled(signal.reason))
    return Promise.allSettled(this.providers.map((provider) => provider.discover(signal))).then((results) => {
      const byEndpoint = new Map<string, BackendCandidate>()
      for (const result of results) {
        if (result.status !== 'fulfilled') continue
        for (const candidate of result.value) {
          if (!isLoopbackCandidate(candidate)) continue
          const key = `${candidate.endpoint.host}:${candidate.endpoint.port}`
          const existing = byEndpoint.get(key)
          if (existing === undefined || rank(candidate) > rank(existing)) byEndpoint.set(key, candidate)
        }
      }
      return [...byEndpoint.values()].sort((left, right) => {
        const score = rank(right) - rank(left)
        if (score !== 0) return score
        return left.endpoint.port - right.endpoint.port
      })
    })
  }
}

function rank(candidate: BackendCandidate): number {
  const sourceWeight: Record<BackendCandidate['source'], number> = {
    configured: 50,
    known: 40,
    companion: 30,
    'process-scan': 20,
    'default-port': 10,
  }
  return sourceWeight[candidate.source] * 1000 + candidate.confidence
}

function isLoopbackCandidate(candidate: BackendCandidate): boolean {
  return (
    (candidate.endpoint.host === '127.0.0.1' || candidate.endpoint.host === 'localhost') &&
    Number.isInteger(candidate.endpoint.port) &&
    candidate.endpoint.port >= 1 &&
    candidate.endpoint.port <= 65535 &&
    candidate.endpoint.baseUrl === `http://${candidate.endpoint.host}:${candidate.endpoint.port}`
  )
}
