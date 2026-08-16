import type * as vscode from 'vscode'
import type { BackendCandidate } from '@dsh-vscode/domain'

import { discoveryCancelled, type DiscoveryProvider } from './provider.js'

export class KnownInstanceDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'known-instance'

  public constructor(private readonly workspaceState: vscode.Memento) {}

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted === true) return Promise.reject(discoveryCancelled(signal.reason))
    const value = this.workspaceState.get<unknown>('dsh.lastEndpoint')
    if (!isEndpointRecord(value)) return Promise.resolve([])
    return Promise.resolve([
      {
        endpoint: value.endpoint,
        source: 'known',
        confidence: 90,
      },
    ])
  }
}

function isEndpointRecord(
  value: unknown,
): value is { endpoint: { host: '127.0.0.1' | 'localhost'; port: number; baseUrl: string } } {
  if (typeof value !== 'object' || value === null || !('endpoint' in value)) return false
  const endpoint = value.endpoint
  if (typeof endpoint !== 'object' || endpoint === null) return false
  if (!('host' in endpoint) || !('port' in endpoint) || !('baseUrl' in endpoint)) return false
  const host = endpoint.host
  const port = endpoint.port
  const baseUrl = endpoint.baseUrl
  return (
    (host === '127.0.0.1' || host === 'localhost') &&
    typeof port === 'number' &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535 &&
    typeof baseUrl === 'string' &&
    baseUrl === `http://${host}:${port}`
  )
}
