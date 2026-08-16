import type { BackendCandidate } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DiscoveryProvider } from './provider.js'

export class LinuxProcessDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'linux-process'

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    return unimplemented<Promise<readonly BackendCandidate[]>>('Linux running DSH discovery', [
      'use bounded /proc and socket inspection or ss without a shell pipeline',
      'match dsh web processes and exact loopback listen ports',
      'treat permission failures as a skipped provider and require protocol probing for all results',
      `signal present ${String(signal !== undefined)}`,
    ])
  }
}
