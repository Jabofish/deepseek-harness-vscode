import type { DshTransport } from '../../contracts.js'
import { Rc6SessionRepository } from '../../repositories/session-repository.js'
import type { Rc6WorkspaceRepository } from '../../repositories/workspace-repository.js'
import { Rc8VersionAdapter } from '../rc8/adapter.js'

/**
 * DSH 0.1.1-rc.1 keeps the rc.8 API/event wire shape and adds the official
 * workspace blank-session adoption fields to session.create.
 */
export class Rc11VersionAdapter extends Rc8VersionAdapter {
  public override readonly id = 'dsh-0.1.1-rc.1'
  public override readonly supportedVersion = '0.1.1-rc.1'
  public override readonly fallback = false
  public override readonly protocolVersion = 'rc11'

  protected override acceptsRuntimeHint(version: string | undefined): boolean {
    return version === this.supportedVersion
  }

  protected override createSessionRepository(
    transport: DshTransport,
    workspaces: Rc6WorkspaceRepository,
  ): Rc6SessionRepository {
    return new Rc6SessionRepository(transport, workspaces, this.options.samePath, {
      reuseWorkspaceBlank: true,
    })
  }
}
