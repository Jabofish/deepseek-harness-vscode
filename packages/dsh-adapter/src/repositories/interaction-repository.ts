import type { InteractionRepository, PermissionOption } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'

export class Rc6InteractionRepository implements InteractionRepository {
  public constructor(private readonly transport: DshTransport) {}

  public respondToPermission(
    requestId: string,
    option: PermissionOption,
    signal?: AbortSignal,
  ): Promise<void> {
    return unimplemented<Promise<void>>('rc6 permission response', [
      'submit exactly one supported option for the live interaction request',
      'make duplicate UI responses idempotent',
      'render and log no hidden command or secret payload',
      `request ${requestId}; option ${option.id}; signal present ${String(signal !== undefined)}; transport available ${String(this.transport !== undefined)}`,
    ])
  }

  public respondToQuestion(
    questionId: string,
    response: string | readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    return unimplemented<Promise<void>>('rc6 user question response', [
      'validate response shape against the live question options',
      'support free text and multiple choice exactly as advertised by DSH',
      'reject stale questions with a recoverable UI refresh',
      `question ${questionId}; response items ${Array.isArray(response) ? response.length : 1}; signal present ${String(signal !== undefined)}`,
    ])
  }
}
