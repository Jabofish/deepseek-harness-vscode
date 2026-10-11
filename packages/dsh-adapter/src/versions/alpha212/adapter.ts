import type { VersionAdapterIdentity } from '../../adapter-base.js'
import type { Alpha171AdapterOptions } from '../alpha171/adapter.js'
import { Alpha211VersionAdapter } from '../alpha211/adapter.js'

export type Alpha212AdapterOptions = Alpha171AdapterOptions

/**
 * Exact adapter for the DSH 0.2.1-alpha.2 source/tag contract.
 *
 * Retains the alpha.1 Session V4 and projection-v2 control wire unchanged.
 * This patch release is only distinguished from alpha.1 by its version
 * identity; the wire contract is identical, so the adapter is a pure subclass
 * of {@link Alpha211VersionAdapter}.
 */
export class Alpha212VersionAdapter extends Alpha211VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.1-alpha.2',
    supportedVersion: '0.2.1-alpha.2',
    protocolVersion: 'alpha212',
    compatibilityPriority: 280,
    fallback: false,
  }

  public constructor(options: Alpha212AdapterOptions) {
    super(options)
  }
}
