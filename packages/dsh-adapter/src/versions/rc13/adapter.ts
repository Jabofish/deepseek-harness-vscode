import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Alpha5VersionAdapter, type Alpha5AdapterOptions } from '../alpha5/adapter.js'

export type Rc13AdapterOptions = Alpha5AdapterOptions

/**
 * Adapter for the published DSH 0.1.2-rc.1 release.
 *
 * The release train changed package versions and cold-session internals, but
 * its browser-facing Connection/Gateway/Session contract is still the
 * alpha.5 family. Keep that fact explicit: rc.1 must not inherit the v2
 * Session wire introduced by the later 0.1.3-alpha.1 source snapshot.
 */
export class Rc13VersionAdapter extends Alpha5VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.2-rc.1',
    supportedVersion: '0.1.2-rc.1',
    protocolVersion: 'rc13',
    compatibilityPriority: 125,
    fallback: false,
  }
}
