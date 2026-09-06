import type * as vscode from 'vscode'
import type { BackendCandidate } from '@dsh-vscode/domain'

import { discoveryCancelled, type DiscoveryProvider } from './provider.js'

export class KnownInstanceDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'known-instance'

  public constructor(private readonly workspaceState: vscode.Memento) {}

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted === true) return Promise.reject(discoveryCancelled(signal.reason))
    const value = this.workspaceState.get<unknown>('dsh.lastEndpoint')
    const port = knownEndpointPort(value)
    if (port === undefined) return Promise.resolve([])
    return Promise.resolve([
      {
        endpoint: {
          host: '127.0.0.1',
          port,
          baseUrl: `http://127.0.0.1:${port}`,
        },
        source: 'known',
        confidence: 90,
      },
    ])
  }
}

function knownEndpointPort(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (isPort(record.port)) return record.port

  // Read the pre-hardening shape once for migration. A successful connection
  // overwrites it with the port-only shape above.
  const endpoint = record.endpoint
  if (typeof endpoint !== 'object' || endpoint === null || Array.isArray(endpoint)) return undefined
  const candidate = endpoint as Record<string, unknown>
  const host = candidate.host
  const port = candidate.port
  const baseUrl = candidate.baseUrl
  return (host === '127.0.0.1' || host === 'localhost') &&
    isPort(port) &&
    baseUrl === `http://${host}:${port}`
    ? port
    : undefined
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}
