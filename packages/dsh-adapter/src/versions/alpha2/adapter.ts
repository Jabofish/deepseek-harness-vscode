import type { BackendEndpoint } from '@dsh-vscode/domain'

import { AlphaVersionAdapter, type AlphaAdapterOptions } from '../alpha/adapter.js'
import type { AlphaLoopbackApiClientOptions } from '../alpha/transport.js'
import { normalizeAlpha2ErrorCode } from './error-vocabulary.js'

export type Alpha2AdapterOptions = AlphaAdapterOptions

/** Adapter for the published upstream 0.1.2-alpha.2 Connection/Gateway protocol. */
export class Alpha2VersionAdapter extends AlphaVersionAdapter {
  public override readonly id = 'dsh-0.1.2-alpha.2'
  public override readonly supportedVersion = '0.1.2-alpha.2'
  public override readonly protocolVersion = 'alpha2'
  public override readonly fallback = false

  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    return {
      ...super.createTransportOptions(endpoint),
      normalizeErrorCode: normalizeAlpha2ErrorCode,
    }
  }
}
