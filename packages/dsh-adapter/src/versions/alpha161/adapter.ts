import type { DshTransport } from '../../contracts.js'
import { readPermissionCatalog } from './permission-catalog.js'
import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Rc152VersionAdapter, type Rc152AdapterOptions } from '../rc152/adapter.js'

export type Alpha161AdapterOptions = Rc152AdapterOptions

/**
 * Adapter for the DSH 0.1.6-alpha.1 source/tag contract.
 *
 * Audited against dsh-v0.1.6-alpha.1 at
 * 0a15e36e7f82b6ed45af6fa9759f29b40dcd965d.
 *
 * The upstream tag keeps the Connection/Gateway and Session v3 wire used by
 * rc.2. It adds projection-owned events such as `image/offload`; the shared
 * mapper preserves those non-surface records as redacted opaque events until
 * their product-specific projection is implemented. Keep this release as a
 * separate exact identity so the v3 reuse is backed by the audited tag rather
 * than inferred from its semver shape.
 */
export class Alpha161VersionAdapter extends Rc152VersionAdapter {
  protected override permissionCatalogReader(
    transport: DshTransport,
  ): (signal?: AbortSignal) => Promise<readonly string[]> {
    return (signal) => readPermissionCatalog(transport, signal)
  }

  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.6-alpha.1',
    supportedVersion: '0.1.6-alpha.1',
    protocolVersion: 'alpha161',
    compatibilityPriority: 190,
    fallback: false,
  }
}
