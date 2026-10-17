import type { PluginBundleRepository } from '@dsh-vscode/domain'
import type { VersionAdapterIdentity } from '../../adapter-base.js'
import type { AlphaLoopbackApiClient } from '../alpha/transport.js'
import { Alpha213VersionAdapter } from '../alpha213/adapter.js'
import { Alpha214PluginBundleRepository } from './plugin-manager-repository.js'

/** dsh-v0.2.1-alpha.4 / 86a402200d95fecef4529d969836f1fe13c6cb0d. */
export class Alpha214VersionAdapter extends Alpha213VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.1-alpha.4',
    supportedVersion: '0.2.1-alpha.4',
    protocolVersion: 'alpha214',
    compatibilityPriority: 300,
    fallback: false,
  }

  protected override createPluginBundleRepository(transport: AlphaLoopbackApiClient): PluginBundleRepository {
    return new Alpha214PluginBundleRepository(transport)
  }
}
