import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Alpha223VersionAdapter } from '../alpha223/adapter.js'

/** dsh-v0.2.2-rc.1 / 66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db.
 * Only package versions changed since alpha.3; all consumed source is identical.
 * Retain batched Session projections and native Host Schedules under an exact identity.
 */
export class Rc221VersionAdapter extends Alpha223VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.2-rc.1',
    supportedVersion: '0.2.2-rc.1',
    protocolVersion: 'rc221',
    compatibilityPriority: 380,
    fallback: false,
  }
}
