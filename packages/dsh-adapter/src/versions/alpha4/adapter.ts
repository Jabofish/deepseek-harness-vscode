import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Alpha3VersionAdapter, type Alpha3AdapterOptions } from '../alpha3/adapter.js'

export type Alpha4AdapterOptions = Alpha3AdapterOptions

/**
 * Adapter for DSH 0.1.2-alpha.4.
 *
 * Alpha.3 -> alpha.4 changed Session's internal sequence/offset brands,
 * inherited-event metadata, and Subagent delivery internals. The upstream
 * Session Controller translates those values back to the unchanged v0 browser
 * wire (`seedLength`, numeric sequence fields, and the same Remote methods).
 * Gateway/Connection framing, namespaced Remote errors, and the Web Profile
 * launch flags also remain compatible, so reuse the alpha.3 transport and
 * mapper while retaining an exact alpha.4 identity.
 */
export class Alpha4VersionAdapter extends Alpha3VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.2-alpha.4',
    supportedVersion: '0.1.2-alpha.4',
    protocolVersion: 'alpha4',
    compatibilityPriority: 110,
    fallback: false,
  }
}
