import type { BackendCapabilities, BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import type { DshTransport, DshVersionAdapter } from './contracts.js'

/**
 * Version identity is the only part of an adapter that every release entry
 * must declare. Transport, probing, and backend assembly stay in the family
 * root rather than being duplicated in each release entry, so a new
 * compatible release cannot accidentally fork them.
 */
export interface VersionAdapterIdentity {
  readonly id: string
  readonly supportedVersion: string
  readonly protocolVersion: string
  readonly compatibilityPriority: number
  readonly fallback: boolean
}

/**
 * Common structural base for all version adapters.
 *
 * The upstream history has two protocol families in this repository: the
 * legacy rc Host API and the alpha Connection/Gateway API. The concrete
 * family implementations therefore form separate linear chains, while this
 * base centralizes the public identity surface used by probing and factory
 * selection.
 */
export abstract class DshVersionAdapterBase implements DshVersionAdapter {
  protected abstract readonly identity: VersionAdapterIdentity

  public get id(): string {
    return this.identity.id
  }

  public get supportedVersion(): string {
    return this.identity.supportedVersion
  }

  public get protocolVersion(): string {
    return this.identity.protocolVersion
  }

  public get compatibilityPriority(): number {
    return this.identity.compatibilityPriority
  }

  public get fallback(): boolean {
    return this.identity.fallback
  }

  public abstract probe(
    candidate: BackendCandidate,
    signal?: AbortSignal,
  ): Promise<BackendCapabilities | undefined>

  public abstract probeCompatibility(
    candidate: BackendCandidate,
    signal?: AbortSignal,
  ): Promise<BackendCapabilities | undefined>

  public abstract createTransport(endpoint: BackendEndpoint): DshTransport
}
