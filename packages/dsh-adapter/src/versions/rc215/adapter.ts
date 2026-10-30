import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Rc214VersionAdapter } from '../rc214/adapter.js'

/** dsh-v0.2.1-rc.5 / b830ec950faba0a46dda564be3e2d854afed94f1.
 * Gateway, typed Remotes, Session V4, tools and managed launch match rc.4.
 * Reasoning Body Slot changes belong to presentation, not the Remote wire.
 */
export class Rc215VersionAdapter extends Rc214VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.1-rc.5',
    supportedVersion: '0.2.1-rc.5',
    protocolVersion: 'rc215',
    compatibilityPriority: 355,
    fallback: false,
  }
}
