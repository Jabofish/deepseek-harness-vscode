import type { BackendEndpoint, PluginBundleRepository } from '@dsh-vscode/domain'

import type { VersionAdapterIdentity } from '../../adapter-base.js'
import type { Rc6SessionRepositoryOptions } from '../../repositories/session-repository.js'
import type { Rc6WorkspaceRepository } from '../../repositories/workspace-repository.js'
import type { SubagentRepositoryOptions } from '../../repositories/subagent-repository.js'
import type { AlphaLoopbackApiClient, AlphaLoopbackApiClientOptions } from '../alpha/transport.js'
import { Alpha211VersionAdapter } from '../alpha211/adapter.js'
import { alpha212SessionProfile } from './session-wire.js'
import { Alpha212SessionRepository } from './session-repository.js'
import { Alpha212PluginBundleRepository } from './plugin-manager-repository.js'
import { Alpha212SubagentRepository } from './subagent-repository.js'

/** Exact DSH alpha.2. Older release admission and routing remain independent. */
export class Alpha212VersionAdapter extends Alpha211VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.1-alpha.2',
    supportedVersion: '0.2.1-alpha.2',
    protocolVersion: 'alpha212',
    compatibilityPriority: 280,
    fallback: false,
  }

  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    return { ...super.createTransportOptions(endpoint), sessionWireProfile: alpha212SessionProfile }
  }

  protected override createSubagentRepository(
    transport: AlphaLoopbackApiClient,
    options: SubagentRepositoryOptions,
  ): Alpha212SubagentRepository {
    return new Alpha212SubagentRepository(transport, options)
  }

  protected override createSessionRepository(
    transport: AlphaLoopbackApiClient,
    workspaces: Rc6WorkspaceRepository,
    options: Rc6SessionRepositoryOptions,
  ): Alpha212SessionRepository {
    return new Alpha212SessionRepository(transport, workspaces, this.options.samePath, options)
  }

  protected override createPluginBundleRepository(transport: AlphaLoopbackApiClient): PluginBundleRepository {
    return new Alpha212PluginBundleRepository(transport)
  }
}
