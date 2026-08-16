import type { BackendCandidate } from '@dsh-vscode/domain'

import { discoveryCancelled, type DiscoveryProvider } from './provider.js'
import { parseDshProcessCandidates, runDiscoveryCommand } from './process-provider.js'

export class MacOsProcessDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'macos-process'

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted === true) return Promise.reject(discoveryCancelled(signal.reason))
    if (process.platform !== 'darwin') return Promise.resolve([])
    return Promise.all([
      runDiscoveryCommand('ps', ['-axo', 'pid=,command='], signal),
      runDiscoveryCommand('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN'], signal),
    ])
      .then(([processes, listeners]) => parseDshProcessCandidates(processes, listeners))
      .catch(() => [])
  }
}
