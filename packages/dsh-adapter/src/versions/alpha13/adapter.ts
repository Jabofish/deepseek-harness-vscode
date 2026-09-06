import type { BackendEndpoint } from '@dsh-vscode/domain'

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
 * adapters so an alpha.1-.5 runtime can never receive a v2 request.
 */
export class Alpha13VersionAdapter extends Alpha5VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.3-alpha.1',
    supportedVersion: '0.1.3-alpha.1',
    protocolVersion: 'alpha13',
    compatibilityPriority: 130,
    fallback: true,
  }

  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    return {
      ...super.createTransportOptions(endpoint),
      sessionWireVersion: 'v2',
    }
  }
}
