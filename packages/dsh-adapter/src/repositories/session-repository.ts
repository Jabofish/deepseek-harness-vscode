import type {
  AgentConfiguration,
  PromptInput,
  SessionCreateInput,
  SessionDetail,
  SessionListQuery,
  SessionPage,
  SessionRepository,
  QueuedInput,
  RunningInputMode,
} from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'

export class Rc6SessionRepository implements SessionRepository {
  public constructor(private readonly transport: DshTransport) {}

  public list(query?: SessionListQuery, signal?: AbortSignal): Promise<SessionPage> {
    return unimplemented(
      'rc6 list sessions repository method',
      this.requirements('list', query?.workspaceId, signal),
    )
  }

  public get(sessionId: string, signal?: AbortSignal): Promise<SessionDetail> {
    return unimplemented('rc6 get session repository method', this.requirements('get', sessionId, signal))
  }

  public create(input: SessionCreateInput, signal?: AbortSignal): Promise<SessionDetail> {
    return unimplemented(
      'rc6 create session repository method',
      this.requirements('create', input.workspaceId, signal),
    )
  }

  public remove(sessionId: string, signal?: AbortSignal): Promise<void> {
    return unimplemented(
      'rc6 remove session repository method',
      this.requirements('remove', sessionId, signal),
    )
  }

  public rename(sessionId: string, title: string, signal?: AbortSignal): Promise<void> {
    return unimplemented(
      'rc6 rename session repository method',
      this.requirements('rename', `${sessionId}:${title}`, signal),
    )
  }

  public fork(sessionId: string, signal?: AbortSignal): Promise<SessionDetail> {
    return unimplemented('rc6 fork session repository method', this.requirements('fork', sessionId, signal))
  }

  public setArchived(sessionId: string, archived: boolean, signal?: AbortSignal): Promise<void> {
    return unimplemented(
      'rc6 archive session repository method',
      this.requirements('archive', `${sessionId}:${String(archived)}`, signal),
    )
  }

  public sendPrompt(input: PromptInput, signal?: AbortSignal): Promise<void> {
    return unimplemented(
      'rc6 send prompt repository method',
      this.requirements('sendPrompt', input.sessionId, signal),
    )
  }

  public enqueuePrompt(
    input: PromptInput,
    mode: RunningInputMode,
    signal?: AbortSignal,
  ): Promise<QueuedInput> {
    return unimplemented(
      'rc6 enqueue or steer prompt',
      this.requirements('enqueuePrompt', `${input.sessionId}:${mode}`, signal),
    )
  }

  public listQueue(sessionId: string, signal?: AbortSignal): Promise<readonly QueuedInput[]> {
    return unimplemented('rc6 list queued prompts', this.requirements('listQueue', sessionId, signal))
  }

  public updateQueuedInput(inputId: string, text: string, signal?: AbortSignal): Promise<void> {
    return unimplemented(
      'rc6 update queued prompt',
      this.requirements('updateQueue', `${inputId}:${text.length}`, signal),
    )
  }

  public removeQueuedInput(inputId: string, signal?: AbortSignal): Promise<void> {
    return unimplemented('rc6 remove queued prompt', this.requirements('removeQueue', inputId, signal))
  }

  public convertQueuedInputToSteer(inputId: string, signal?: AbortSignal): Promise<void> {
    return unimplemented(
      'rc6 convert queued prompt to steer',
      this.requirements('convertToSteer', inputId, signal),
    )
  }

  public cancel(sessionId: string, signal?: AbortSignal): Promise<void> {
    return unimplemented(
      'rc6 cancel session repository method',
      this.requirements('cancel', sessionId, signal),
    )
  }

  public setConfiguration(
    sessionId: string,
    configuration: AgentConfiguration,
    signal?: AbortSignal,
  ): Promise<void> {
    return unimplemented(
      'rc6 update session configuration repository method',
      this.requirements('setConfiguration', `${sessionId}:${configuration.preset}`, signal),
    )
  }

  private requirements(
    operation: string,
    key: string | undefined,
    signal: AbortSignal | undefined,
  ): readonly string[] {
    return [
      'use only the corresponding entry from the official rc6 rpc-map',
      'map requests and validated responses exclusively through the rc6 version layer',
      'pass AbortSignal through transport and map errors to stable AppError codes',
      'add success, server error, malformed response, timeout, and cancellation contract tests',
      `operation ${operation}; key ${key ?? 'none'}; signal present ${String(signal !== undefined)}; transport available ${String(this.transport !== undefined)}`,
    ]
  }
}
