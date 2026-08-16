import type { BackendCandidate } from '@dsh-vscode/domain'

export interface DiscoveryProvider {
  readonly id: string
  discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]>
}
