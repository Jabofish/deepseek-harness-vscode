import type { BackendCandidate, BackendCapabilities } from '@dsh-vscode/domain'
import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Rc212VersionAdapter } from '../rc212/adapter.js'

/** dsh-v0.2.1-rc.3 / 1f81c047fc48fa190a683e469daa699857e9afe8.
 * Remote/Gateway/V4/tool declarations retain rc.2 wire. The native client now
 * names a reusable workspace blank, matching an explicit preset before create.
 * Model listings and listing-cache configuration remain runtime-owned catalogs.
 */
export class Rc213VersionAdapter extends Rc212VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.1-rc.3',
    supportedVersion: '0.2.1-rc.3',
    protocolVersion: 'rc213',
    compatibilityPriority: 340,
    fallback: false,
  }

  public override async probe(
    candidate: BackendCandidate,
    signal?: AbortSignal,
  ): Promise<BackendCapabilities | undefined> {
    const capabilities = await super.probe(candidate, signal)
    return capabilities === undefined ? undefined : { ...capabilities, blankSessionReuse: true }
  }
}
