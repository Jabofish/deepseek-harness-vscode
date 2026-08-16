import type { BackendCandidate } from '@dsh-vscode/domain'

export interface DiscoveryProvider {
  readonly id: string
  discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]>
}

export function discoveryCancelled(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('DSH discovery was cancelled.')
}
