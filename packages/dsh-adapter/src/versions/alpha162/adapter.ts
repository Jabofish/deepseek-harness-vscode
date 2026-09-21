import type { BackendEndpoint } from '@dsh-vscode/domain'

import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Alpha161VersionAdapter, type Alpha161AdapterOptions } from '../alpha161/adapter.js'
import type { AlphaLoopbackApiClientOptions } from '../alpha/transport.js'
import { normalizeAlpha2ErrorCode } from '../alpha2/error-vocabulary.js'

export type Alpha162AdapterOptions = Alpha161AdapterOptions

/**
 * Adapter for the DSH 0.1.6-alpha.2 source/tag contract.
 *
 * Alpha.2 keeps the Connection/Gateway and Session v3 wire, but its
 * Session-Control baseline now carries the durable `inbox` projection rather
 * than the alpha.1 `queues` snapshot. The exact identity and control profile
 * stay separate even though the common v3 repository assembly is reused.
 */
export class Alpha162VersionAdapter extends Alpha161VersionAdapter {
  protected override readonly supportsWorkspaceChanges = true
  protected override readonly supportsLiveGoal = true
  protected override readonly supportsFileUploads = true

  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.6-alpha.2',
    supportedVersion: '0.1.6-alpha.2',
    protocolVersion: 'alpha162',
    compatibilityPriority: 200,
    fallback: false,
  }

  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    return {
      ...super.createTransportOptions(endpoint),
      controlWireVersion: 'inbox-v1',
      fileUploads: true,
      cordisClientBoundary: true,
      normalizeErrorCode: normalizeAlpha2ErrorCode,
    }
  }
}
