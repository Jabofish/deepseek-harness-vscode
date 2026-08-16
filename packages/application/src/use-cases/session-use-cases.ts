import type {
  PromptInput,
  QueuedInput,
  RunningInputMode,
  SessionCreateInput,
  SessionDetail,
  SessionListQuery,
  SessionPage,
} from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { BackendService } from '../services/backend-service.js'

export class SessionUseCases {
  public constructor(private readonly backendService: BackendService) {}

  public list(query?: SessionListQuery, signal?: AbortSignal): Promise<SessionPage> {
    return unimplemented<Promise<SessionPage>>('list sessions', [
      'delegate to the active backend repository',
      'preserve stable updated-at ordering',
      'honor optional workspace filtering and cancellation',
      `workspace filter: ${query?.workspaceId ?? 'none'}; search: ${query?.search ?? 'none'}; signal present: ${String(signal !== undefined)}`,
      `backend guard available: ${String(this.backendService !== undefined)}`,
    ])
  }

  public create(input: SessionCreateInput, signal?: AbortSignal): Promise<SessionDetail> {
    return unimplemented<Promise<SessionDetail>>('create session', [
      'validate workspace and configuration before transport mapping',
      'delegate to the versioned adapter through the domain repository',
      'return the canonical created session',
      `workspace: ${input.workspaceId}; signal present: ${String(signal !== undefined)}`,
    ])
  }

  public sendPrompt(input: PromptInput, signal?: AbortSignal): Promise<void> {
    return unimplemented<Promise<void>>('send prompt', [
      'reject empty text only when no attachments exist',
      'deduplicate UI submissions by request id at the message-router boundary',
      'stream progress only through normalized backend events',
      `session: ${input.sessionId}; signal present: ${String(signal !== undefined)}`,
    ])
  }

  public cancel(sessionId: string, signal?: AbortSignal): Promise<void> {
    return unimplemented<Promise<void>>('cancel active turn', [
      'use the DSH cancellation RPC for the selected session',
      'be idempotent when the session is already idle',
      `session: ${sessionId}; signal present: ${String(signal !== undefined)}`,
    ])
  }

  public fork(sessionId: string, signal?: AbortSignal): Promise<SessionDetail> {
    return unimplemented<Promise<SessionDetail>>('fork session', [
      'delegate to the DSH session fork RPC and return the canonical child session',
      'preserve parent relationship and open the child only after creation succeeds',
      `session: ${sessionId}; signal present: ${String(signal !== undefined)}`,
    ])
  }

  public setArchived(sessionId: string, archived: boolean, signal?: AbortSignal): Promise<void> {
    return unimplemented<Promise<void>>('archive or restore session', [
      'persist archive state through DSH and refresh the active list query',
      'keep the selected session accessible until the server acknowledges the mutation',
      `session: ${sessionId}; archived: ${String(archived)}; signal present: ${String(signal !== undefined)}`,
    ])
  }

  public enqueuePrompt(
    input: PromptInput,
    mode: RunningInputMode,
    signal?: AbortSignal,
  ): Promise<QueuedInput> {
    return unimplemented<Promise<QueuedInput>>('queue or steer a running session', [
      'validate that the active session is running and the selected mode is supported',
      'delegate to DSH queue or steer semantics without converting to an ordinary prompt',
      'reconcile returned id with subsequent queue events',
      `session: ${input.sessionId}; mode: ${mode}; signal present: ${String(signal !== undefined)}`,
    ])
  }
}
