import type { BackendCandidate } from '@dsh-vscode/domain'

export interface DiscoveryProvider {
  readonly id: string
  discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]>
}

export function discoveryCancelled(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('DSH discovery was cancelled.')
}

export function isDiscoveryCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true
  if (typeof error !== 'object' || error === null) return false
  const record = error as { readonly code?: unknown; readonly name?: unknown }
  return record.name === 'AbortError' || record.code === 'ABORT_ERR'
}
