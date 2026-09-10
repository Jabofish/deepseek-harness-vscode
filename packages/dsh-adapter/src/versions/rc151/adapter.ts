import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Alpha152VersionAdapter, type Alpha152AdapterOptions } from '../alpha152/adapter.js'

export type Rc151AdapterOptions = Alpha152AdapterOptions

/**
 * Adapter for the current DSH 0.1.5-rc.1 release.
 *
 * rc.1 retains the alpha.2 Connection/Gateway and strict Session v3 wire.
 * Keep the release candidate as its own exact identity because the runtime
 * label is part of the compatibility evidence and future releases must not
 * inherit this contract by semver shape alone.
 */
export class Rc151VersionAdapter extends Alpha152VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.5-rc.1',
    supportedVersion: '0.1.5-rc.1',
    protocolVersion: 'rc151',
    compatibilityPriority: 170,
    fallback: false,
  }
}
