import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Alpha13VersionAdapter, type Alpha13AdapterOptions } from '../alpha13/adapter.js'

export type Alpha132AdapterOptions = Alpha13AdapterOptions

/**
 * Adapter for the released upstream DSH 0.1.3-alpha.2 contract.
 *
 * Alpha.2 keeps the alpha.1 Session v2 and Connection/Gateway wire, but its
 * subagent control request makes the queue/steer `delivery` discriminator
 * mandatory. Keep that change behind a distinct exact version identity so
 * older alpha/rc runtimes never receive a field their strict schema rejects.
 */
export class Alpha132VersionAdapter extends Alpha13VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.3-alpha.2',
    supportedVersion: '0.1.3-alpha.2',
    protocolVersion: 'alpha132',
    compatibilityPriority: 140,
    fallback: false,
  }

  protected override readonly supportsSubagentPromptDelivery = true
}
