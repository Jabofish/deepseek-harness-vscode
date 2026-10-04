import type {
  AccountLifecycleRepository,
  BackendEvent,
  PluginBundleRepository,
  ScheduleRepository,
  ModsBandRepository,
  InspectorDevtoolsRepository,
  BackendEndpoint,
} from '@dsh-vscode/domain'

import type { VersionAdapterIdentity } from '../../adapter-base.js'
import type { AlphaLoopbackApiClient } from '../alpha/transport.js'
import { Rc202VersionAdapter } from '../rc202/adapter.js'
import { Alpha211ScheduleRepository } from './schedule-repository.js'
import { Alpha211AccountLifecycleRepository } from './account-repository.js'
import { Alpha211PluginBundleRepository } from './plugin-manager-repository.js'
import { createAlpha211SessionNormalizer } from './tool-preparation.js'
import { Alpha211ModsBandRepository } from './mods-band-repository.js'
import { Alpha211InspectorRepository } from './inspector-repository.js'

/** Exact DSH dsh-v0.2.1-alpha.1 at 5badb15009ae1756c3afe0ae0cef1faafc290ccc. */
export class Alpha211VersionAdapter extends Rc202VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.1-alpha.1',
    supportedVersion: '0.2.1-alpha.1',
    protocolVersion: 'alpha211',
    compatibilityPriority: 270,
    fallback: false,
  }

  protected override createScheduleRepository(transport: AlphaLoopbackApiClient): ScheduleRepository {
    return new Alpha211ScheduleRepository(transport)
  }

  protected override createAccountLifecycleRepository(
    transport: AlphaLoopbackApiClient,
  ): AccountLifecycleRepository {
    return new Alpha211AccountLifecycleRepository(transport)
  }

  protected override createPluginBundleRepository(transport: AlphaLoopbackApiClient): PluginBundleRepository {
    return new Alpha211PluginBundleRepository(transport)
  }

  protected override createSessionEventNormalizer(): (frame: unknown) => BackendEvent | undefined {
    return createAlpha211SessionNormalizer()
  }

  protected override createModsBandRepository(transport: AlphaLoopbackApiClient): ModsBandRepository {
    return new Alpha211ModsBandRepository(transport)
  }
  protected override createInspectorRepository(endpoint: BackendEndpoint): InspectorDevtoolsRepository {
    return new Alpha211InspectorRepository(this.createTransportOptions(endpoint))
  }
}
