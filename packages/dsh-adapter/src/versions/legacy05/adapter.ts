import type { DshTransport } from '../../contracts.js'
import { Rc6SessionRepository } from '../../repositories/session-repository.js'
import type { Rc6WorkspaceRepository } from '../../repositories/workspace-repository.js'
import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Rc6VersionAdapter } from '../rc6/adapter.js'

/** rc.5 returned to the rc.6 RPC/event family while still using older session projections. */
export class LegacyRc5VersionAdapter extends Rc6VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.0.1-rc.5',
    supportedVersion: '0.0.1-rc.5',
    protocolVersion: 'legacy-rc5',
    compatibilityPriority: 20,
    fallback: false,
  }

  protected override acceptsRuntimeHint(version: string | undefined): boolean {
    return version === this.supportedVersion
  }

  protected override createSessionRepository(
    transport: DshTransport,
    workspaces: Rc6WorkspaceRepository,
  ): Rc6SessionRepository {
    return new Rc6SessionRepository(transport, workspaces, this.options.samePath, {
      preallocatedSessionId: true,
    })
  }
}
