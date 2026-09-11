import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Rc151VersionAdapter, type Rc151AdapterOptions } from '../rc151/adapter.js'

export type Rc152AdapterOptions = Rc151AdapterOptions

/**
 * Adapter for DSH 0.1.5-rc.2.
 *
 * The release keeps the rc.1 Connection/Gateway and strict Session v3 wire
 * contract. It remains a separate exact identity so the selected runtime is
 * recorded accurately and future releases cannot inherit this contract from
 * a semver-shaped label alone.
 */
export class Rc152VersionAdapter extends Rc151VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.5-rc.2',
    supportedVersion: '0.1.5-rc.2',
    protocolVersion: 'rc152',
    compatibilityPriority: 180,
    fallback: false,
  }
}
