import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { LegacyRc5VersionAdapter } from '../legacy05/adapter.js'

/** 0.1.0-rc.2 is byte-compatible with the pinned rc.6 Host API package. */
export class Rc02VersionAdapter extends LegacyRc5VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.0-rc.2',
    supportedVersion: '0.1.0-rc.2',
    protocolVersion: 'rc02',
    compatibilityPriority: 25,
    fallback: false,
  }

  protected override acceptsRuntimeHint(version: string | undefined): boolean {
    return version === this.supportedVersion
  }
}
