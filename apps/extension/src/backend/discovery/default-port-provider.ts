import type { BackendCandidate } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DiscoveryProvider } from './provider.js'

export class DefaultPortDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'default-port'

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    return unimplemented<Promise<readonly BackendCandidate[]>>('DSH default port candidate discovery', [
      'derive the default from official rc6 behavior or configuration, never from a broad port scan',
      'return loopback-only candidates requiring protocol verification',
      `signal present ${String(signal !== undefined)}`,
    ])
  }
}
