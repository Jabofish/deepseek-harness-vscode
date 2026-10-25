import {
  AppError,
  type QuestionReplyStatus,
  type TimedUserQuestionAnswer,
  type UserQuestionRepository,
} from '@dsh-vscode/domain'

import type { BackendService } from '../services/backend-service.js'

export class UserQuestionUseCases {
  public constructor(private readonly backendService: BackendService) {}

  public attachWait(sessionId: string, callId: string, signal?: AbortSignal): Promise<number | undefined> {
    return this.repository().attachWait(sessionId, callId, signal)
  }

  public releaseWait(sessionId: string, callId: string): Promise<void> {
    return this.repository().releaseWait(sessionId, callId)
  }

  public answer(
    sessionId: string,
    callId: string,
    answer: TimedUserQuestionAnswer,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.repository().answer(sessionId, callId, answer, signal)
  }

  public replyStatus(sessionId: string, callId: string, signal?: AbortSignal): Promise<QuestionReplyStatus> {
    const repository = this.repository()
    if (repository.readReplyStatus !== undefined) return repository.readReplyStatus(sessionId, callId, signal)
    throw new AppError({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'The connected DSH cannot read the question reply state.',
      retryable: false,
    })
  }

  private repository(): UserQuestionRepository {
    const repository = this.backendService.requireBackend().userQuestions
    if (repository !== undefined) return repository
    throw new AppError({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'The connected DSH version does not expose timed user questions.',
      retryable: false,
    })
  }
}
