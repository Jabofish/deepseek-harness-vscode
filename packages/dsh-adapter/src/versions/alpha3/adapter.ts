import type { BackendEndpoint } from '@dsh-vscode/domain'

import { AlphaVersionAdapter, type AlphaAdapterOptions } from '../alpha/adapter.js'
import type { AlphaLoopbackApiClientOptions } from '../alpha/transport.js'
import { normalizeAlpha2ErrorCode } from '../alpha2/error-vocabulary.js'

export type Alpha3AdapterOptions = AlphaAdapterOptions

/**
 * Adapter for DSH 0.1.2-alpha.3. The upstream alpha.2 → alpha.3 source diff
 * changes Gateway heartbeat tolerance, ConnectionController readiness
 * reporting, and Session Controller presentation/attachment admission, but
 * keeps the Connection/Gateway wire shapes and Remote error vocabulary. The
 * transport therefore remains shared while the runtime identity stays exact.
 */
export class Alpha3VersionAdapter extends AlphaVersionAdapter {
  public override readonly id = 'dsh-0.1.2-alpha.3'
  public override readonly supportedVersion = '0.1.2-alpha.3'
  public override readonly protocolVersion = 'alpha3'
  public override readonly compatibilityPriority: number = 100
  public override readonly fallback = false

  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    return {
      ...super.createTransportOptions(endpoint),
      normalizeErrorCode: normalizeAlpha2ErrorCode,
    }
  }
}
