import type * as vscode from 'vscode'
import type { BackendCandidate } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DiscoveryProvider } from './provider.js'

export class KnownInstanceDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'known-instance'

  public constructor(private readonly workspaceState: vscode.Memento) {}

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    return unimplemented<Promise<readonly BackendCandidate[]>>('last-known DSH instance discovery', [
      'read endpoint metadata only from workspaceState',
      'never persist credentials, prompt content, or external process ownership claims',
      'return stale endpoints as low-confidence candidates that still require health probing',
      `state keys ${this.workspaceState.keys().length}; signal present ${String(signal !== undefined)}`,
    ])
  }
}
