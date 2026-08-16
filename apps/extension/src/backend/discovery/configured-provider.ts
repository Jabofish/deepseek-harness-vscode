import type { BackendCandidate } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DiscoveryProvider } from './provider.js'

export class ConfiguredPortDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'configured-ports'

  public constructor(private readonly ports: () => readonly number[]) {}

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    return unimplemented<Promise<readonly BackendCandidate[]>>('configured DSH port discovery', [
      'turn unique valid attachPorts into loopback candidates',
      'assign highest deterministic confidence after an explicitly configured endpoint',
      'perform no network calls in this provider',
      `ports ${this.ports().join(',')}; signal present ${String(signal !== undefined)}`,
    ])
  }
}
