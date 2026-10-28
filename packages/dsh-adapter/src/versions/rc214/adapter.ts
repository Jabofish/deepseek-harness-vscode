import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Rc213VersionAdapter } from '../rc213/adapter.js'

/** dsh-v0.2.1-rc.4 / 504a01a9578abc2c6f1fb896b1dc322c9fe24f66.
 * Consumed Gateway, Remotes, Session V4, tools and launch wire match rc.3.
 * ACP stdout fixes, MCP discovery and browser tab labels need no wire override.
 */
export class Rc214VersionAdapter extends Rc213VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.1-rc.4',
    supportedVersion: '0.2.1-rc.4',
    protocolVersion: 'rc214',
    compatibilityPriority: 350,
    fallback: false,
  }
}
