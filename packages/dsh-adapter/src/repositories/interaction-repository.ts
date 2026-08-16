import {
  AppError,
  type BackendEvent,
  type InteractionRepository,
  type PermissionOption,
  type QuestionAnswer,
  type UserQuestionItem,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'

export class Rc6InteractionRepository implements InteractionRepository {
  private readonly answered = new Map<string, number>()
  private readonly permissions = new Map<
    string,
    {
      readonly rpcId: string
      readonly sessionId: string
      readonly options: readonly PermissionOption[]
    }
  >()
  private readonly questions = new Map<
    string,
    {
      readonly rpcId: string
      readonly sessionId: string
      readonly questionIds: readonly string[]
      readonly items: readonly UserQuestionItem[]
    }
  >()
  private readonly responding = new Map<string, Promise<void>>()
  public constructor(private readonly transport: DshTransport) {}

  public remember(event: BackendEvent): void {
    if (event.type === 'session.subscribed') {
      for (const [id, pending] of this.permissions)
        if (pending.sessionId === event.sessionId) this.permissions.delete(id)
      for (const [id, pending] of this.questions)
        if (pending.sessionId === event.sessionId) this.questions.delete(id)
      return
    }
    if (event.type === 'permission.requested' && event.request.rpcId !== undefined)
      this.permissions.set(event.request.id, {
        rpcId: event.request.rpcId,
        sessionId: event.request.sessionId,
        options: event.request.options,
      })
    if (event.type === 'permission.resolved') this.permissions.delete(event.requestId)
    if (event.type === 'question.requested' && event.question.rpcId !== undefined) {
      const items = event.question.items ?? [
        {
          id: event.question.id,
          prompt: event.question.prompt,
          ...(event.question.choices === undefined ? {} : { choices: event.question.choices }),
          ...(event.question.multiSelect === undefined ? {} : { multiSelect: event.question.multiSelect }),
          allowFreeText: event.question.allowFreeText,
        },
      ]
      const questionIds = [...new Set(items.map((item) => item.id))]
      for (const id of questionIds)
        this.questions.set(id, {
          rpcId: event.question.rpcId,
          sessionId: event.question.sessionId,
          questionIds,
          items,
        })
    }
    if (event.type === 'question.resolved') {
      for (const [id, pending] of this.questions) {
        if (
          (event.questionRpcId !== undefined && pending.rpcId === event.questionRpcId) ||
          (event.questionId !== undefined && id === event.questionId)
        )
          this.questions.delete(id)
      }
    }
  }

  public async respondToPermission(requestId: string, optionId: string, signal?: AbortSignal): Promise<void> {
    if (this.answered.has(requestId)) return
    const active = this.responding.get(requestId)
    if (active !== undefined) return active
    const operation = this.respondToPermissionOnce(requestId, optionId, signal)
    this.responding.set(requestId, operation)
    return operation.finally(() => this.responding.delete(requestId))
  }

  private async respondToPermissionOnce(
    requestId: string,
    optionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.transport.respondEnvelope === undefined)
      throw new AppError({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'The connected DSH cannot answer permission requests.',
        retryable: false,
      })
    const pending = this.permissions.get(requestId)
    if (pending === undefined) throw staleInteraction('permission request')
    const option = pending.options.find((candidate) => candidate.id === optionId)
    if (option === undefined)
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The DSH permission option is not part of the pending request.',
        retryable: false,
      })
    const outcome = option.kind === 'allow-once' ? 'allowed-once' : 'rejected'
    await this.transport.respondEnvelope(
      pending.rpcId,
      { ok: true, value: { sessionId: pending.sessionId, approvalId: requestId, outcome } },
      signal,
    )
    this.markAnswered([requestId])
    this.permissions.delete(requestId)
  }

  public async respondToQuestion(
    questionId: string,
    response: string | readonly string[] | readonly QuestionAnswer[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.answered.has(questionId)) return
    const active = this.responding.get(questionId)
    if (active !== undefined) return active
    const operation = this.respondToQuestionOnce(questionId, response, signal)
    this.responding.set(questionId, operation)
    return operation.finally(() => this.responding.delete(questionId))
  }

  private async respondToQuestionOnce(
    questionId: string,
    response: string | readonly string[] | readonly QuestionAnswer[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.transport.respondEnvelope === undefined)
      throw new AppError({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'The connected DSH cannot answer user questions.',
        retryable: false,
      })
    const pending = this.questions.get(questionId)
    if (pending === undefined) throw staleInteraction('question')
    const isBatch = Array.isArray(response) && response.every((entry) => isQuestionAnswer(entry))
    if (!isBatch && pending.questionIds.length > 1)
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The DSH question request contains multiple questions; submit one batch response.',
        retryable: false,
      })
    const answers = isBatch
      ? batchAnswers(response, pending)
      : [singleAnswer(questionId, response as string | readonly string[], pending.items)]
    await this.transport.respondEnvelope(
      pending.rpcId,
      { ok: true, value: { sessionId: pending.sessionId, answer: { answers } } },
      signal,
    )
    for (const id of pending.questionIds) {
      this.markAnswered([id])
      this.questions.delete(id)
    }
  }

  private markAnswered(ids: readonly string[]): void {
    const now = Date.now()
    for (const id of ids) {
      this.answered.delete(id)
      this.answered.set(id, now)
    }
    while (this.answered.size > 1_024) {
      const oldest = this.answered.keys().next().value
      if (typeof oldest !== 'string') break
      this.answered.delete(oldest)
    }
  }
}

function isQuestionAnswer(value: unknown): value is QuestionAnswer {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'response' in value &&
    typeof value.id === 'string' &&
    (typeof value.response === 'string' ||
      (Array.isArray(value.response) && value.response.every((entry) => typeof entry === 'string')))
  )
}

function answer(
  id: string,
  response: string | readonly string[],
): {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
} {
  return {
    id,
    selected: typeof response === 'string' ? [] : [...response],
    ...(typeof response === 'string' && response.length > 0 ? { custom: response } : {}),
  }
}

function batchAnswers(
  responses: readonly QuestionAnswer[],
  pending: {
    readonly questionIds: readonly string[]
    readonly items: readonly UserQuestionItem[]
  },
): readonly {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}[] {
  const ids = responses.map((entry) => entry.id)
  if (
    responses.length !== pending.questionIds.length ||
    new Set(ids).size !== ids.length ||
    pending.questionIds.some((id) => !ids.includes(id))
  )
    throw invalidQuestionAnswer()
  return responses.map((entry) => singleAnswer(entry.id, entry.response, pending.items))
}

function singleAnswer(
  id: string,
  response: string | readonly string[],
  items: readonly UserQuestionItem[],
): {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
} {
  const item = items.find((candidate) => candidate.id === id)
  if (item === undefined) throw staleInteraction('question item')
  const choices = new Set((item.choices ?? []).map((choice) => choice.id))
  if (typeof response === 'string') {
    if (!item.allowFreeText && !choices.has(response)) throw invalidQuestionAnswer()
  } else {
    if (item.multiSelect !== true && response.length > 1) throw invalidQuestionAnswer()
    if (response.length === 0 || response.some((entry) => !choices.has(entry))) throw invalidQuestionAnswer()
  }
  return answer(id, response)
}

function invalidQuestionAnswer(): AppError {
  return new AppError({
    code: 'INVALID_CONFIGURATION',
    message: 'The DSH question response does not match the pending questions.',
    retryable: false,
  })
}

function staleInteraction(kind: string): AppError {
  return new AppError({
    code: 'STALE_INTERACTION',
    message: `The DSH ${kind} is no longer pending.`,
    retryable: true,
  })
}
