import type { DshTransport } from '../../contracts.js'
import { Rc6VersionAdapter } from '../rc6/adapter.js'
import { Rc6SessionRepository } from '../../repositories/session-repository.js'
import type { Rc6WorkspaceRepository } from '../../repositories/workspace-repository.js'
import { Rc8CommandRepository } from '../../repositories/command-repository.js'

/** rc.8 adds the `home` host-describe field and new durable event families. */
export class Rc8VersionAdapter extends Rc6VersionAdapter {
  public override readonly id: string = 'dsh-0.1.0-rc.8'
  public override readonly supportedVersion: string = '0.1.0-rc.8'
  public override readonly compatibilityPriority: number = 50
  public override readonly fallback = false
  public override readonly protocolVersion: string = 'rc8'
  protected override readonly requiresHome = true

  protected override acceptsRuntimeHint(version: string | undefined): boolean {
    // A missing or unknown runtime hint cannot prove that the rc.8-only
    // handshake/event additions are present. The explicit compatibility probe
    // bypasses this exact-version check and verifies the contract separately.
    return version === this.supportedVersion
  }

  protected override createCommandRepository(transport: DshTransport): Rc8CommandRepository {
    return new Rc8CommandRepository(transport)
  }

  protected override createSessionRepository(
    transport: DshTransport,
    workspaces: Rc6WorkspaceRepository,
  ): Rc6SessionRepository {
    // rc.8's commands/execute Remote requires the images array even for the
    // attachment-free /permission and /plan configuration commands.
    return new Rc6SessionRepository(transport, workspaces, this.options.samePath, {
      includeEmptyCommandImages: true,
    })
  }
}
