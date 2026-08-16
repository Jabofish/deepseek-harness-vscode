import type {
  PromptAttachment,
  PromptInput,
  QueuedInput,
  RunningInputMode,
  SessionCreateInput,
  SessionDetail,
  SessionListQuery,
  SessionPage,
} from '@dsh-vscode/domain'

import type { BackendService } from '../services/backend-service.js'

export class SessionUseCases {
  public constructor(private readonly backendService: BackendService) {}

  public list(query?: SessionListQuery, signal?: AbortSignal): Promise<SessionPage> {
    return this.backendService.requireBackend().sessions.list(query, signal)
  }

  public create(input: SessionCreateInput, signal?: AbortSignal): Promise<SessionDetail> {
    if (input.workspaceId.trim() === '') throw new Error('Workspace is required')
    return this.backendService.requireBackend().sessions.create(input, signal)
  }

  public remove(sessionId: string, signal?: AbortSignal): Promise<void> {
    return this.backendService.requireBackend().sessions.remove(sessionId, signal)
  }

  public sendPrompt(input: PromptInput, signal?: AbortSignal): Promise<void> {
    if (input.text.trim() === '' && input.attachments.length === 0) throw new Error('Prompt cannot be empty')
    return this.backendService.requireBackend().sessions.sendPrompt(input, signal)
  }

  public cancel(sessionId: string, signal?: AbortSignal): Promise<void> {
    return this.backendService.requireBackend().sessions.cancel(sessionId, signal)
  }

  public fork(sessionId: string, atSeq?: number, signal?: AbortSignal): Promise<SessionDetail> {
    return this.backendService.requireBackend().sessions.fork(sessionId, atSeq, signal)
  }

  public readAttachment(
    sessionId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<PromptAttachment> {
    return this.backendService.requireBackend().sessions.readAttachment(sessionId, attachmentId, signal)
  }

  public setArchived(sessionId: string, archived: boolean, signal?: AbortSignal): Promise<void> {
    return this.backendService.requireBackend().sessions.setArchived(sessionId, archived, signal)
  }

  public enqueuePrompt(
    input: PromptInput,
    mode: RunningInputMode,
    signal?: AbortSignal,
  ): Promise<QueuedInput> {
    if (input.text.trim() === '' && input.attachments.length === 0) throw new Error('Prompt cannot be empty')
    return this.backendService.requireBackend().sessions.enqueuePrompt(input, mode, signal)
  }
}
