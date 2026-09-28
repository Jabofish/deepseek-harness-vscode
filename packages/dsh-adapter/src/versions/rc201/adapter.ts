import type { VersionAdapterIdentity } from '../../adapter-base.js'
import type { ScheduleRepository } from '@dsh-vscode/domain'
import type { AlphaLoopbackApiClient } from '../alpha/transport.js'
import { Rc172VersionAdapter } from '../rc172/adapter.js'
import { Rc201ScheduleRepository } from './schedule-repository.js'

/**
 * Exact adapter for DSH dsh-v0.2.0-rc.1 at
 * 4878cdabd87d4041bdaff61d04c966883b9fd07a. The consumed Gateway,
 * Connection, Session V4, Workspace, Job, Account, Schedule and Plugin Remote
 * sources are unchanged since the audited 21638c5 pre-release snapshot.
 * The optional Schedule bundle still needs the version-scoped unavailable map.
 */
export class Rc201VersionAdapter extends Rc172VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.0-rc.1',
    supportedVersion: '0.2.0-rc.1',
    protocolVersion: 'rc201',
    compatibilityPriority: 250,
    fallback: false,
  }

  protected override createScheduleRepository(transport: AlphaLoopbackApiClient): ScheduleRepository {
    return new Rc201ScheduleRepository(transport)
  }
}
