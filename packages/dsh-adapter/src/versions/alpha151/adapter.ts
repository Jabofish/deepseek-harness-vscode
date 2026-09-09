import type { BackendEndpoint } from '@dsh-vscode/domain'

import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Alpha132VersionAdapter, type Alpha132AdapterOptions } from '../alpha132/adapter.js'
import type { AlphaLoopbackApiClientOptions } from '../alpha/transport.js'

export type Alpha151AdapterOptions = Alpha132AdapterOptions

/**
 * Adapter for the released upstream DSH 0.1.5-alpha.1 contract.
 *
 * The Connection/Gateway and subagent contracts remain compatible with
 * alpha.2, while Session Controller moves from wire v2 to strict wire v3:
 * event envelopes are exact, surface replacements use startSeq/endSeq, and
 * system/message plus PTC event names are part of the current vocabulary.
 * Keep this as an exact-only seam so no older runtime receives v3 fields.
 */
export class Alpha151VersionAdapter extends Alpha132VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.5-alpha.1',
    supportedVersion: '0.1.5-alpha.1',
    protocolVersion: 'alpha151',
    compatibilityPriority: 150,
    fallback: false,
  }

  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    return {
      ...super.createTransportOptions(endpoint),
      sessionWireVersion: 'v3',
    }
  }
}
