import type { AccountLifecycleRepository } from '@dsh-vscode/domain'
import type { VersionAdapterIdentity } from '../../adapter-base.js'
import type { AlphaLoopbackApiClient } from '../alpha/transport.js'
import { Alpha214VersionAdapter } from '../alpha214/adapter.js'
import { Alpha215AccountLifecycleRepository } from './account-repository.js'

/** dsh-v0.2.1-alpha.5 / 1517a4dbca0a2789ff1d41ba439600f8547d23fa. */
export class Alpha215VersionAdapter extends Alpha214VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.1-alpha.5',
    supportedVersion: '0.2.1-alpha.5',
    protocolVersion: 'alpha215',
    compatibilityPriority: 310,
    fallback: false,
  }

  protected override createAccountLifecycleRepository(
    transport: AlphaLoopbackApiClient,
  ): AccountLifecycleRepository {
    return new Alpha215AccountLifecycleRepository(transport)
  }
}
