import { AppError } from '@dsh-vscode/domain'
import { Rc213SessionRepository } from '../rc213/session-repository.js'
import { callRpc } from '../rc6/rpc.js'

/** This release reads a full ImageAttachmentRef and no longer checks its log ownership.
 * Resolve that authority from native history, never from a Webview-supplied reference.
 */
export class Alpha222SessionRepository extends Rc213SessionRepository {
  protected override async requestAttachment(
    sessionId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted()
    const deadline = AbortSignal.timeout(30_000)
    const reading = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    let before: number | undefined
    while (true) {
      const page = await this.history(sessionId, before, reading, { pageSize: 500 })
      reading.throwIfAborted()
      for (const { event } of page.events) {
        const images =
          event.type === 'tool.updated'
            ? event.tool.images
            : event.type === 'message.user' || event.type === 'message.completed'
              ? event.images
              : undefined
        const attachment = images?.find((image) => image.attachmentId === attachmentId)
        if (attachment !== undefined)
          return callRpc(this.remoteTransport, 'session.attachment', { sessionId, attachment }, reading)
      }
      if (!page.hasMore)
        throw new AppError({
          code: 'PERMISSION_DENIED',
          message: 'The image is not referenced by this session.',
          retryable: false,
        })
      const next = page.beforeSequence
      if (next === undefined || next < 0 || (before !== undefined && next >= before))
        throw new AppError({
          code: 'PROTOCOL_ERROR',
          message: 'Invalid image history cursor.',
          retryable: false,
        })
      before = next
    }
  }
}
