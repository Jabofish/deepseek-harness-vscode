import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Rc222VersionAdapter } from '../rc222/adapter.js'

/**
 * dsh-v0.2.2-rc.3 / 38a6a5c965aa99ab525161efb7cc5cf1fe62fced.
 * Consumed Gateway, Session V4, Remote and plugin-management contracts retain
 * the rc.2 wire. Official bundles remain discovered from the running Host.
 */
export class Rc223VersionAdapter extends Rc222VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.2-rc.3',
    supportedVersion: '0.2.2-rc.3',
    protocolVersion: 'rc223',
    compatibilityPriority: 400,
    fallback: false,
  }
}
