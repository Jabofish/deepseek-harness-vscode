import type { BackendEndpoint } from '@dsh-vscode/domain'

import type { VersionAdapterIdentity } from '../../adapter-base.js'
import type { AlphaLoopbackApiClientOptions } from '../alpha/transport.js'
import { Alpha171VersionAdapter, type Alpha171AdapterOptions } from '../alpha171/adapter.js'

export type Alpha172AdapterOptions = Alpha171AdapterOptions

/**
 * Exact adapter for the DSH 0.1.7-alpha.2 source/tag contract.
 *
 * Audited against `dsh-v0.1.7-alpha.2` at
 * `00102833dfaee1da9f48a3a8eae9d34005a75218`. It retains the alpha.1
 * Session V4, pinned Workspace, and projection-only Control contracts. The
 * new ordinary-history turn window is enabled only for this exact version.
 */
export class Alpha172VersionAdapter extends Alpha171VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.7-alpha.2',
    supportedVersion: '0.1.7-alpha.2',
    protocolVersion: 'alpha172',
    compatibilityPriority: 220,
    fallback: false,
  }

  public constructor(options: Alpha172AdapterOptions) {
    super(options)
  }

  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    return {
      ...super.createTransportOptions(endpoint),
      sessionHistoryTurnWindow: true,
    }
  }
}
