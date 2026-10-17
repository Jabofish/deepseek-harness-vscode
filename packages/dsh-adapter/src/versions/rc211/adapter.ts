import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Alpha215VersionAdapter } from '../alpha215/adapter.js'

/** dsh-v0.2.1-rc.1 / 1600d8a1e140dcde43a1a0941940a0480712c011.
 * Consumed Remote, Gateway and V4 contracts match alpha.5 byte for byte.
 */
export class Rc211VersionAdapter extends Alpha215VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.1-rc.1',
    supportedVersion: '0.2.1-rc.1',
    protocolVersion: 'rc211',
    compatibilityPriority: 320,
    fallback: false,
  }
}
