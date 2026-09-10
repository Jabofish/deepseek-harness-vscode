import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Alpha151VersionAdapter, type Alpha151AdapterOptions } from '../alpha151/adapter.js'

export type Alpha152AdapterOptions = Alpha151AdapterOptions

/**
 * Adapter for DSH 0.1.5-alpha.2.
 *
 * The release keeps the Session v3 transport introduced by alpha.1 while
 * shipping durable explicit-file delivery and parent-owned subagent catalog
 * events. The event mapper is shared at the alpha family boundary; this
 * identity remains exact-only so the v3 wire is never guessed for an unknown
 * runtime.
 */
export class Alpha152VersionAdapter extends Alpha151VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.5-alpha.2',
    supportedVersion: '0.1.5-alpha.2',
    protocolVersion: 'alpha152',
    compatibilityPriority: 160,
    fallback: false,
  }
}
