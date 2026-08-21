import type { DshTransport } from '../../contracts.js'
import { Rc6SessionRepository } from '../../repositories/session-repository.js'
import type { Rc6WorkspaceRepository } from '../../repositories/workspace-repository.js'
import { Rc8VersionAdapter } from '../rc8/adapter.js'

const RC12_MAX_PROMPT_ATTACHMENT_BYTES = 20 * 1024 * 1024
const RC12_MAX_PROMPT_ATTACHMENT_TOTAL_BYTES = 200 * 1024 * 1024

/**
 * DSH 0.1.1-rc.2 keeps the rc.8 API/event wire shape. It retains the
 * idempotent session.create sessionId but removes rc.1's
 * reuseWorkspaceBlank field from the public schema.
 */
export class Rc12VersionAdapter extends Rc8VersionAdapter {
  public override readonly id = 'dsh-0.1.1-rc.2'
  public override readonly supportedVersion = '0.1.1-rc.2'
  public override readonly fallback = false
  public override readonly protocolVersion = 'rc12'

  protected override acceptsRuntimeHint(version: string | undefined): boolean {
    return version === this.supportedVersion
  }

  protected override createSessionRepository(
    transport: DshTransport,
    workspaces: Rc6WorkspaceRepository,
  ): Rc6SessionRepository {
    return new Rc6SessionRepository(transport, workspaces, this.options.samePath, {
      preallocatedSessionId: true,
      maxPromptAttachmentBytes: RC12_MAX_PROMPT_ATTACHMENT_BYTES,
      maxPromptAttachmentTotalBytes: RC12_MAX_PROMPT_ATTACHMENT_TOTAL_BYTES,
    })
  }
}
