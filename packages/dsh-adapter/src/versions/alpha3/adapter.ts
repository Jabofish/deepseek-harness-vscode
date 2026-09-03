import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Alpha2VersionAdapter, type Alpha2AdapterOptions } from '../alpha2/adapter.js'

export type Alpha3AdapterOptions = Alpha2AdapterOptions

/**
 * Adapter for DSH 0.1.2-alpha.3. The upstream alpha.2 → alpha.3 source diff
 * changes Gateway heartbeat tolerance, ConnectionController readiness
 * reporting, and Session Controller presentation/attachment admission, but
 * keeps the Connection/Gateway wire shapes and Remote error vocabulary. The
 * transport therefore remains shared while the runtime identity stays exact.
 */
export class Alpha3VersionAdapter extends Alpha2VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.2-alpha.3',
    supportedVersion: '0.1.2-alpha.3',
    protocolVersion: 'alpha3',
    compatibilityPriority: 100,
    fallback: false,
  }

  /** Alpha.3 introduced the upload-shaped PromptContentPart subagent wire. */
  protected override readonly supportsInlineSubagentImages = true
}
