import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Rc223VersionAdapter } from '../rc223/adapter.js'

/**
 * dsh-v0.2.2-rc.4 / 3f321d32bfe382212a8ed8785c1d47a5a300aa23.
 * Consumed Gateway, Session V4, Remote, plugin-management and CLI launch
 * contracts retain the rc.3 wire; DeepSeek content-safety refusals now
 * report CONTENT_REFUSED in assistant/attempt and turn/end errors.
 */
export class Rc224VersionAdapter extends Rc223VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.2-rc.4',
    supportedVersion: '0.2.2-rc.4',
    protocolVersion: 'rc224',
    compatibilityPriority: 410,
    fallback: false,
  }
}
