import type { BackendCandidate } from '@dsh-vscode/domain'

import { discoveryCancelled, type DiscoveryProvider } from './provider.js'
import { parseDshProcessCandidates, runDiscoveryCommand } from './process-provider.js'

export class LinuxProcessDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'linux-process'

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted === true) return Promise.reject(discoveryCancelled(signal.reason))
    if (process.platform !== 'linux') return Promise.resolve([])
    return Promise.all([
      runDiscoveryCommand('ps', ['-eo', 'pid=,args='], signal),
      runDiscoveryCommand('ss', ['-ltnp'], signal),
    ])
      .then(([processes, listeners]) => parseDshProcessCandidates(processes, listeners))
      .catch(() => [])
  }
}
