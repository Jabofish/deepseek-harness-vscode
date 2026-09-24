import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Rc152VersionAdapter, type Rc152AdapterOptions } from '../rc152/adapter.js'

export type Rc153AdapterOptions = Rc152AdapterOptions

/**
 * Adapter for DSH 0.1.5-rc.3.
 *
 * The pinned rc.3 source changes release metadata and dependency-policy
 * tooling, but leaves the rc.2 API and wire implementation unchanged. Keep
 * rc.3 as its own exact identity so the runtime label is preserved and future
 * releases cannot inherit this contract from semver shape alone.
 */
export class Rc153VersionAdapter extends Rc152VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.5-rc.3',
    supportedVersion: '0.1.5-rc.3',
    protocolVersion: 'rc153',
    compatibilityPriority: 185,
    fallback: false,
  }
}
