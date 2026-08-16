import type { BackendCandidate } from '@dsh-vscode/domain'
import { readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { discoveryCancelled, type DiscoveryProvider } from './provider.js'

export class CompanionRegistryDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'companion-registry'

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted === true) return Promise.reject(discoveryCancelled(signal.reason))
    const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
    const directory = path.join(home, 'runtime', 'vscode', 'instances')
    return readdir(directory, { withFileTypes: true })
      .then(async (entries) => {
        const candidates: BackendCandidate[] = []
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue
          try {
            const parsed: unknown = JSON.parse(await readFile(path.join(directory, entry.name), 'utf8'))
            const candidate = parseRegistryEntry(parsed)
            if (candidate !== undefined) candidates.push(candidate)
          } catch {
            // A stale or partially-written companion record is a soft failure.
          }
        }
        return candidates
      })
      .catch(() => [])
  }
}

function parseRegistryEntry(value: unknown): BackendCandidate | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const host = record.host
  const port = record.port
  const pid = record.pid
  const version = record.version
  if (
    (host !== '127.0.0.1' && host !== 'localhost') ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    return undefined
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1 || typeof version !== 'string')
    return undefined
  return {
    endpoint: { host, port, baseUrl: `http://${host}:${port}` },
    source: 'companion',
    pid,
    confidence: 60,
  }
}
