import type { BackendCapabilities, BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Alpha5VersionAdapter, type Alpha5AdapterOptions } from '../alpha5/adapter.js'
import type { AlphaLoopbackApiClientOptions } from '../alpha/transport.js'

export type Alpha13AdapterOptions = Alpha5AdapterOptions

/**
 * Adapter for the latest upstream source snapshot 0.1.3-alpha.1.
 *
 * The Connection/Gateway routes remain the alpha.5 family contract, while the
 * Session Controller changed to the v2 wire: seeded headers, event-only
 * history records, and opt-in process-local assistant stream frames. Keep the
 * version identity and the Session wire seam separate from the older alpha
 * adapters so an alpha.1-.5 runtime can never receive a v2 request. The v2
 * Session wire is not negotiated by the read-only session/list probe, so this
 * adapter is exact-only until the upstream exposes a wire-version probe.
 */
export class Alpha13VersionAdapter extends Alpha5VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.3-alpha.1',
    supportedVersion: '0.1.3-alpha.1',
    protocolVersion: 'alpha13',
    compatibilityPriority: 130,
    fallback: false,
  }

  public override probeCompatibility(
    _candidate: BackendCandidate,
    _signal?: AbortSignal,
  ): Promise<BackendCapabilities | undefined> {
    // A session/list success is shared by the v0 and v2 alpha families. Do
    // not select a v2 transport for an unknown runtime without a wire probe.
    return Promise.resolve(undefined)
  }

  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    return {
      ...super.createTransportOptions(endpoint),
      sessionWireVersion: 'v2',
    }
  }
}
