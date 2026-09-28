import type { VersionAdapterIdentity } from '../../adapter-base.js'
import type { ScheduleRepository } from '@dsh-vscode/domain'
import type { AlphaLoopbackApiClient } from '../alpha/transport.js'
import { Rc172VersionAdapter } from '../rc172/adapter.js'
import { Master21638ScheduleRepository } from './schedule-repository.js'

/** Exact adapter for the temporary, commit-bound DSH master validation label. */
export class Master21638VersionAdapter extends Rc172VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.7-master.21638c56315ae6a2b552d6091945d3144c9af32e',
    supportedVersion: '0.1.7-master.21638c56315ae6a2b552d6091945d3144c9af32e',
    // The master snapshot keeps the RC2 Connection/Gateway and Session V4 wire.
    protocolVersion: 'rc172',
    compatibilityPriority: 241,
    // This marker is evidence for one source snapshot, never a future-version fallback.
    fallback: false,
  }

  protected override createScheduleRepository(transport: AlphaLoopbackApiClient): ScheduleRepository {
    return new Master21638ScheduleRepository(transport)
  }
}
