import type { DshTransport } from '../../contracts.js'
import { Rc6SessionRepository } from '../../repositories/session-repository.js'
import type { Rc6WorkspaceRepository } from '../../repositories/workspace-repository.js'
import { Rc11VersionAdapter } from '../rc11/adapter.js'
import type { VersionAdapterIdentity } from '../../adapter-base.js'

const RC12_MAX_PROMPT_ATTACHMENT_BYTES = 20 * 1024 * 1024
const RC12_MAX_PROMPT_ATTACHMENT_TOTAL_BYTES = 200 * 1024 * 1024

/**
 * DSH 0.1.1-rc.2 keeps the rc.8 API/event wire shape. It retains the
 * idempotent session.create sessionId but removes rc.1's
 * reuseWorkspaceBlank field from the public schema.
 */
export class Rc12VersionAdapter extends Rc11VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.1-rc.2',
    supportedVersion: '0.1.1-rc.2',
    protocolVersion: 'rc12',
    compatibilityPriority: 70,
    fallback: false,
  }

  protected override createSessionRepository(
    transport: DshTransport,
    workspaces: Rc6WorkspaceRepository,
  ): Rc6SessionRepository {
    return new Rc6SessionRepository(transport, workspaces, this.options.samePath, {
      preallocatedSessionId: true,
      includeEmptyCommandImages: true,
      maxPromptAttachmentBytes: RC12_MAX_PROMPT_ATTACHMENT_BYTES,
      maxPromptAttachmentTotalBytes: RC12_MAX_PROMPT_ATTACHMENT_TOTAL_BYTES,
    })
  }
}
