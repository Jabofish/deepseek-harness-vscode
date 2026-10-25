import type { QuestionAnswer, QuestionRequestIdentity } from '@dsh-vscode/domain'

import type { BackendService } from '../services/backend-service.js'

export class InteractionUseCases {
  public constructor(private readonly backendService: BackendService) {}

  public respondToPermission(requestId: string, optionId: string, signal?: AbortSignal): Promise<void> {
    return this.backendService.requireBackend().interactions.respondToPermission(requestId, optionId, signal)
  }

  public respondToQuestion(
    questionId: string,
    response: string | readonly string[] | readonly QuestionAnswer[],
    signal?: AbortSignal,
    identity?: QuestionRequestIdentity,
  ): Promise<void> {
    return this.backendService
      .requireBackend()
      .interactions.respondToQuestion(questionId, response, signal, identity)
  }

  public cancelQuestion(
    questionId: string,
    signal?: AbortSignal,
    identity?: QuestionRequestIdentity,
  ): Promise<void> {
    return this.backendService.requireBackend().interactions.cancelQuestion(questionId, signal, identity)
  }
}
