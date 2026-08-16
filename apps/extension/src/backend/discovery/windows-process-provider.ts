import type { BackendCandidate } from '@dsh-vscode/domain'

import { discoveryCancelled, type DiscoveryProvider } from './provider.js'
import { parseDshProcessCandidates, runDiscoveryCommand } from './process-provider.js'

export class WindowsProcessDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'windows-process'

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted === true) return Promise.reject(discoveryCancelled(signal.reason))
    if (process.platform !== 'win32') return Promise.resolve([])
    return Promise.all([
      runDiscoveryCommand('wmic.exe', ['process', 'get', 'CommandLine,ProcessId', '/format:csv'], signal),
      runDiscoveryCommand('netstat.exe', ['-ano'], signal),
    ])
      .then(([processes, listeners]) => parseDshProcessCandidates(processes, listeners))
      .catch(() => [])
  }
}
