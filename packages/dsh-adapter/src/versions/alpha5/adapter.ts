import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Alpha4VersionAdapter, type Alpha4AdapterOptions } from '../alpha4/adapter.js'

export type Alpha5AdapterOptions = Alpha4AdapterOptions

/**
 * Adapter for DSH 0.1.2-alpha.5.
 *
 * The alpha.4 -> alpha.5 upstream source diff changes storage and projection
 * cache compatibility only; it does not change the Connection/Gateway,
 * Session Controller browser wire, Remote error vocabulary, or Web Profile
 * launch flags consumed by this extension. The current master tree after the
 * alpha.5 tag likewise keeps those wire surfaces stable while changing cold
 * Session persistence internals. Keep the implementation shared with alpha.4
 * but expose an independent version identity so exact alpha.5 connections are
 * never reported as alpha.4 connections.
 */
export class Alpha5VersionAdapter extends Alpha4VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.2-alpha.5',
    supportedVersion: '0.1.2-alpha.5',
    protocolVersion: 'alpha5',
    compatibilityPriority: 120,
    fallback: true,
  }
}
