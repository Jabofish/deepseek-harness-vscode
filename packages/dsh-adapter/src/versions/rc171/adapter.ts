import type { BackendEndpoint } from '@dsh-vscode/domain'

import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Alpha171VersionAdapter, type Alpha171AdapterOptions } from '../alpha171/adapter.js'
import type { AlphaLoopbackApiClientOptions } from '../alpha/transport.js'

export type Rc171AdapterOptions = Alpha171AdapterOptions

/**
 * Adapter for the DSH 0.1.7-rc.1 source/tag contract.
 *
 * Audited against dsh-v0.1.7-rc.1 at
 * 46a7f68b0922371ce7144b668b90e377d8e799f4. The `web` profile keeps the
 * Alpha171 Gateway carrier, Session V4 history, projection-only Session
 * Control, and pinned Workspace projection. Its shipped web-app patch also
 * mounts the Host Job Controller and the Client Job Remote, so the dedicated
 * Alpha171 job repository remains active for this exact profile. Session
 * `page` and `follow` accept the optional `turnWindow`; enable that request
 * shaping only for ordinary history reads in the shared transport.
 *
 * Keep this identity exact-only: neither the adjacent alpha tag nor a future
 * RC label is evidence that it exposes this profile and wire contract.
 */
export class Rc171VersionAdapter extends Alpha171VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.7-rc.1',
    supportedVersion: '0.1.7-rc.1',
    protocolVersion: 'rc171',
    compatibilityPriority: 230,
    fallback: false,
  }

  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    return {
      ...super.createTransportOptions(endpoint),
      sessionHistoryTurnWindow: true,
    }
  }
}
