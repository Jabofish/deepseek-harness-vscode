import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Rc02VersionAdapter } from '../rc02/adapter.js'

/** 0.1.0-rc.3 retains the rc.6 Host API wire contract. */
export class Rc03VersionAdapter extends Rc02VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.0-rc.3',
    supportedVersion: '0.1.0-rc.3',
    protocolVersion: 'rc03',
    compatibilityPriority: 27,
    fallback: false,
  }

  protected override acceptsRuntimeHint(version: string | undefined): boolean {
    return version === this.supportedVersion
  }
}
