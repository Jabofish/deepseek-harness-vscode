import type { DshTransport } from '../../contracts.js'
import { Rc6SessionRepository } from '../../repositories/session-repository.js'
import type { Rc6WorkspaceRepository } from '../../repositories/workspace-repository.js'
import { Rc8VersionAdapter } from '../rc8/adapter.js'
import type { VersionAdapterIdentity } from '../../adapter-base.js'

/**
 * DSH 0.1.1-rc.1 keeps the rc.8 API/event wire shape and adds the official
 * workspace blank-session adoption fields to session.create.
 */
export class Rc11VersionAdapter extends Rc8VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.1-rc.1',
    supportedVersion: '0.1.1-rc.1',
    protocolVersion: 'rc11',
    compatibilityPriority: 60,
    fallback: false,
  }

  protected override createSessionRepository(
    transport: DshTransport,
    workspaces: Rc6WorkspaceRepository,
  ): Rc6SessionRepository {
    return new Rc6SessionRepository(transport, workspaces, this.options.samePath, {
      reuseWorkspaceBlank: true,
      commandAttachmentWire: 'images',
    })
  }
}
