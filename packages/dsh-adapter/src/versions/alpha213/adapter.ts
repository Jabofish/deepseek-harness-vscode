import type { BackendEndpoint, PluginBundleRepository } from '@dsh-vscode/domain'
import type { VersionAdapterIdentity } from '../../adapter-base.js'
import type { AlphaLoopbackApiClient, AlphaLoopbackApiClientOptions } from '../alpha/transport.js'
import { Alpha212VersionAdapter } from '../alpha212/adapter.js'
import { normalizeAlpha213ErrorCode } from './error-vocabulary.js'
import { Alpha213PluginBundleRepository } from './plugin-manager-repository.js'

/** dsh-v0.2.1-alpha.3 / 2fbf4359b82fb94c03dcce0b831660d87f12ea5c.
 * V4 codec sources are unchanged from alpha.2; Workspace and Gateway are not.
 */
export class Alpha213VersionAdapter extends Alpha212VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.1-alpha.3',
    supportedVersion: '0.2.1-alpha.3',
    protocolVersion: 'alpha213',
    compatibilityPriority: 290,
    fallback: false,
  }

  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    return {
      ...super.createTransportOptions(endpoint),
      workspaceWireVersion: 'pinned-replace-v3',
      normalizeErrorCode: normalizeAlpha213ErrorCode,
    }
  }

  protected override createPluginBundleRepository(transport: AlphaLoopbackApiClient): PluginBundleRepository {
    return new Alpha213PluginBundleRepository(transport)
  }
}
