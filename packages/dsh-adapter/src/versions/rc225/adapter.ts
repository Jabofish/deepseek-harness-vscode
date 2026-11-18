import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Rc224VersionAdapter } from '../rc224/adapter.js'

/**
 * dsh-v0.2.2-rc.5 / 9c2670d3bce5275e0d1610272958121af87787bb.
 * Consumed Gateway, Session V4, Remote, plugin-management and CLI launch
 * contracts retain the rc.4 wire. Base composition omits web.searchProvider
 * so DSH routes DeepSeek conversations through Messages search by default,
 * while live settings.describe and web/deepseek-search-llm-request remain handled.
 */
export class Rc225VersionAdapter extends Rc224VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.2-rc.5',
    supportedVersion: '0.2.2-rc.5',
    protocolVersion: 'rc225',
    compatibilityPriority: 420,
    fallback: false,
  }
}
