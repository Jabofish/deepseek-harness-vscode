import type { BackendEndpoint } from '@dsh-vscode/domain'

import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Alpha1VersionAdapter, type AlphaAdapterOptions } from '../alpha/adapter.js'
import type { AlphaLoopbackApiClientOptions } from '../alpha/transport.js'
import { normalizeAlpha2ErrorCode } from './error-vocabulary.js'

export type Alpha2AdapterOptions = AlphaAdapterOptions

/** Adapter for the published upstream 0.1.2-alpha.2 Connection/Gateway protocol. */
export class Alpha2VersionAdapter extends Alpha1VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.2-alpha.2',
    supportedVersion: '0.1.2-alpha.2',
    protocolVersion: 'alpha2',
    compatibilityPriority: 90,
    fallback: false,
  }

  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    return {
      ...super.createTransportOptions(endpoint),
      normalizeErrorCode: normalizeAlpha2ErrorCode,
    }
  }
}
