import type { BackendCandidate } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DiscoveryProvider } from './provider.js'

export class MacOsProcessDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'macos-process'

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    return unimplemented<Promise<readonly BackendCandidate[]>>('macOS running DSH discovery', [
      'use bounded lsof and process inspection without shell interpolation',
      'match dsh web and exact loopback listen ports',
      'return no results on permission failure and require protocol probing for every candidate',
      `signal present ${String(signal !== undefined)}`,
    ])
  }
}
