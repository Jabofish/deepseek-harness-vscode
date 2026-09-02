import { Rc6VersionAdapter } from '../rc6/adapter.js'
import type { VersionAdapterIdentity } from '../../adapter-base.js'

/** rc.7 retained the rc.6 Host API wire shape; keep its identity explicit. */
export class Rc7VersionAdapter extends Rc6VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.0-rc.7',
    supportedVersion: '0.1.0-rc.7',
    protocolVersion: 'rc7',
    compatibilityPriority: 40,
    fallback: false,
  }

  protected override acceptsRuntimeHint(version: string | undefined): boolean {
    return version === this.supportedVersion
  }
}
