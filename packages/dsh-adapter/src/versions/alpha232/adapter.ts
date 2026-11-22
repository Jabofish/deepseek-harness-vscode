import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Alpha231VersionAdapter } from '../alpha231/adapter.js'

/** dsh-v0.2.3-alpha.2 / 4b399c39a6d1479cd84ca591b4d7c88e24d38a96. */
export class Alpha232VersionAdapter extends Alpha231VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.3-alpha.2',
    supportedVersion: '0.2.3-alpha.2',
    protocolVersion: 'alpha232',
    compatibilityPriority: 440,
    fallback: false,
  }
}
