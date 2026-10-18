import type * as vscode from 'vscode'
import type { BackendCandidate } from '@dsh-vscode/domain'

import { discoveryCancelled, type DiscoveryProvider } from './provider.js'

export class KnownInstanceDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'known-instance'

  public constructor(private readonly workspaceState: vscode.Memento) {}

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted === true) return Promise.reject(discoveryCancelled(signal.reason))
    const value = this.workspaceState.get<unknown>('dsh.lastEndpoint')
    const endpoint = knownEndpoint(value)
    if (endpoint === undefined) return Promise.resolve([])
    const pid = typeof value === 'object' && value !== null && 'pid' in value ? value.pid : undefined
    return Promise.resolve([
      {
        endpoint,
        source: 'known',
        confidence: 90,
        ...(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? { processIdHint: pid } : {}),
      },
    ])
  }
}

function knownEndpoint(value: unknown): BackendCandidate['endpoint'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (isPort(record.port)) {
    const host = record.host ?? '127.0.0.1'
    if (host !== '127.0.0.1' && host !== 'localhost') return undefined
    return { host, port: record.port, baseUrl: `http://${host}:${record.port}` }
  }

  // Read the pre-hardening shape once for migration. A successful connection
  // overwrites it with the host/port shape above.
  const endpoint = record.endpoint
  if (typeof endpoint !== 'object' || endpoint === null || Array.isArray(endpoint)) return undefined
  const candidate = endpoint as Record<string, unknown>
  const host = candidate.host
  const port = candidate.port
  const baseUrl = candidate.baseUrl
  return (host === '127.0.0.1' || host === 'localhost') &&
    isPort(port) &&
    baseUrl === `http://${host}:${port}`
    ? { host, port, baseUrl }
    : undefined
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}
