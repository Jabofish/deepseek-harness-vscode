import {
  AppError,
  QuestionSettlements,
  matchesQuestionResolution,
  type BackendEvent,
  type InteractionRepository,
  type PermissionOption,
  type QuestionAnswer,
  type UserQuestionItem,
  type UserQuestion,
  type QuestionRequestIdentity,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'

interface SharedResponse {
  readonly intent: string
  readonly controller: AbortController
  readonly promise: Promise<void>
  callers: number
  settled: boolean
}

interface PendingQuestion {
  readonly rpcId: string
  readonly sessionId: string
  readonly questionIds: readonly string[]
  readonly items: readonly UserQuestionItem[]
  readonly question: UserQuestion
}

export class Rc6InteractionRepository implements InteractionRepository {
  private readonly answered = new Map<string, number>()
  private readonly settlements = new QuestionSettlements()
  private readonly permissions = new Map<
    string,
    {
      readonly rpcId: string
      readonly sessionId: string
      readonly options: readonly PermissionOption[]
    }
  >()
  private readonly questions = new Map<string, PendingQuestion>()
  private readonly responding = new Map<string, SharedResponse>()
  private readonly resetPendingOnSubscribe: boolean
  private readonly onSettled: ((event: BackendEvent) => void) | undefined
  public constructor(
    private readonly transport: DshTransport,
    options?: {
      readonly resetPendingOnSubscribe?: boolean
      /**
       * Report a locally accepted settlement to the backend event source.
       *
       * The rc.6-family host broadcasts a resolution frame to every subscriber;
       * a transport that only reports a settlement to the *other* clients (alpha
       * Remote Events) must echo the accepted `$events/result` here or replayed
       * surfaces keep showing a request that can no longer be answered.
       */
      readonly onSettled?: (event: BackendEvent) => void
    },
  ) {
    this.resetPendingOnSubscribe = options?.resetPendingOnSubscribe ?? true
    this.onSettled = options?.onSettled
  }

  /** Return the session that owns a currently remembered permission request. */
  public sessionForPermission(requestId: string): string | undefined {
    return this.permissions.get(requestId)?.sessionId
  }

  public permissionOptionKind(requestId: string, optionId: string): PermissionOption['kind'] | undefined {
    return this.permissions.get(requestId)?.options.find((option) => option.id === optionId)?.kind
  }

  /** Return the session that owns a currently remembered question item. */
  public sessionForQuestion(questionId: string, identity?: QuestionRequestIdentity): string | undefined {
    return this.pendingQuestion(questionId, identity)?.sessionId
  }

  private pendingQuestion(id: string, identity?: QuestionRequestIdentity): PendingQuestion | undefined {
    const matches = [...this.questions.values()].filter(
      (pending) =>
        pending.questionIds.includes(id) &&
        (identity === undefined ||
          (pending.sessionId === identity.sessionId && pending.rpcId === identity.rpcId)),
    )
    // The public legacy route only names an item. Never pick another session's
    // request when model-supplied ids collide.
    if (matches.length > 1) throw staleInteraction('ambiguous question')
    return matches[0]
  }

  public remember(event: BackendEvent): void {
    if (event.type === 'connection.lost') {
      this.questions.clear()
      return
    }
    if (event.type === 'question.reply.status' && event.state === 'admitted')
      this.settlements.acceptCall(event.sessionId, event.callId)
    if (event.type === 'session.projection' && event.key === 'userQuestions')
      this.settlements.project(event.sessionId, event.value)
    if (event.type === 'session.subscribed' && event.projection !== undefined)
      this.settlements.project(event.sessionId, event.projection.values.userQuestions)
    if (event.type === 'session.projection.baseline')
      for (const [sessionId, projection] of Object.entries(event.projections))
        this.settlements.project(sessionId, projection.values.userQuestions)
    if (
      event.type === 'question.reply.status' ||
      event.type === 'session.projection' ||
      event.type === 'session.projection.baseline' ||
      event.type === 'session.subscribed'
    )
      for (const [key, pending] of this.questions)
        if (this.settlements.has(pending.question)) this.questions.delete(key)
    if (event.type === 'session.subscribed') {
      // The rc.6-family mux replays each session's still-pending
      // approval/question requested frames right after the subscribed frame
      // (rpcId reused verbatim), so wiping here and letting the replay
      // re-register is the refresh-recovery baseline. Alpha delivers
      // approvals and questions as $events waterfalls and a session/follow
      // (re)subscription replays nothing — wiping there would destroy a
      // pending interaction the host still waits on.
      if (!this.resetPendingOnSubscribe) return
      for (const [id, pending] of this.permissions)
        if (pending.sessionId === event.sessionId) this.permissions.delete(id)
      for (const [id, pending] of this.questions)
        if (pending.sessionId === event.sessionId) this.questions.delete(id)
      return
    }
    if (event.type === 'permission.requested' && event.request.rpcId !== undefined) {
      this.answered.delete(event.request.id)
      this.permissions.set(event.request.id, {
        rpcId: event.request.rpcId,
        sessionId: event.request.sessionId,
        options: event.request.options,
      })
    }
    if (event.type === 'permission.resolved') this.permissions.delete(event.requestId)
    if (event.type === 'question.requested' && event.question.rpcId !== undefined) {
      if (this.settlements.has(event.question)) return
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
      for (const id of questionIds) this.answered.delete(id)
      this.questions.set(JSON.stringify([event.question.sessionId, event.question.rpcId]), {
        rpcId: event.question.rpcId,
        sessionId: event.question.sessionId,
        questionIds,
        items,
        question: event.question,
      })
    }
    if (event.type === 'question.resolved') {
      this.settlements.resolve(
        event,
        [...this.questions.values()].map((pending) => pending.question),
      )
      for (const [key, pending] of this.questions)
        if (matchesQuestionResolution(pending.question, event)) this.questions.delete(key)
    }
  }

  public async respondToPermission(requestId: string, optionId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw cancelledResponse()
    if (this.answered.has(requestId)) return
    const respondEnvelope = this.transport.respondEnvelope?.bind(this.transport)
    if (respondEnvelope === undefined)
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
    const payload = { ok: true, value: { sessionId: pending.sessionId, approvalId: requestId, outcome } }
    return this.shareResponse(
      `permission:${pending.rpcId}`,
      JSON.stringify(payload),
      async (operationSignal) => {
        const receipt = await respondEnvelope(pending.rpcId, payload, operationSignal)
        assertAcceptedReceipt(receipt)
        this.markAnswered([requestId])
        this.permissions.delete(requestId)
        this.onSettled?.({
          type: 'permission.resolved',
          sessionId: pending.sessionId,
          requestId,
          outcome,
        })
      },
      signal,
    )
  }

  public async respondToQuestion(
    questionId: string,
    response: string | readonly string[] | readonly QuestionAnswer[],
    signal?: AbortSignal,
    identity?: QuestionRequestIdentity,
  ): Promise<void> {
    if (signal?.aborted) throw cancelledResponse()
    if (
      this.pendingQuestion(questionId, identity) === undefined &&
      (identity === undefined
        ? this.answered.has(questionId)
        : this.settlements.hasRpc(identity.sessionId, identity.rpcId))
    )
      return
    const respondEnvelope = this.transport.respondEnvelope?.bind(this.transport)
    if (respondEnvelope === undefined)
      throw new AppError({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'The connected DSH cannot answer user questions.',
        retryable: false,
      })
    const pending = this.pendingQuestion(questionId, identity)
    if (pending === undefined) throw staleInteraction('question')
    const isBatch =
      Array.isArray(response) && response.length > 0 && response.every((entry) => isQuestionAnswer(entry))
    if (!isBatch && pending.questionIds.length > 1)
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The DSH question request contains multiple questions; submit one batch response.',
        retryable: false,
      })
    const answers = isBatch
      ? batchAnswers(response, pending)
      : [singleAnswer({ id: questionId, response: response as string | readonly string[] }, pending.items)]
    const payload = { ok: true, value: { sessionId: pending.sessionId, answer: { answers } } }
    return this.shareResponse(
      `question:${pending.rpcId}`,
      JSON.stringify(payload),
      async (operationSignal) => {
        const receipt = await respondEnvelope(pending.rpcId, payload, operationSignal)
        assertAcceptedReceipt(receipt)
        this.settleQuestion(pending, 'answered')
      },
      signal,
    )
  }

  public async cancelQuestion(
    questionId: string,
    signal?: AbortSignal,
    identity?: QuestionRequestIdentity,
  ): Promise<void> {
    if (signal?.aborted) throw cancelledResponse()
    if (
      this.pendingQuestion(questionId, identity) === undefined &&
      (identity === undefined
        ? this.answered.has(questionId)
        : this.settlements.hasRpc(identity.sessionId, identity.rpcId))
    )
      return
    const respondEnvelope = this.transport.respondEnvelope?.bind(this.transport)
    if (respondEnvelope === undefined)
      throw new AppError({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'The connected DSH cannot cancel user questions.',
        retryable: false,
      })
    const pending = this.pendingQuestion(questionId, identity)
    if (pending === undefined) throw staleInteraction('question')
    const payload = {
      ok: false,
      error: {
        code: 'cancelled',
        message: 'the user closed this question request',
        details: {},
      },
    }
    return this.shareResponse(
      `question:${pending.rpcId}`,
      JSON.stringify(payload),
      async (operationSignal) => {
        const receipt = await respondEnvelope(pending.rpcId, payload, operationSignal)
        assertAcceptedReceipt(receipt)
        this.settleQuestion(pending, 'cancelled')
      },
      signal,
    )
  }

  /** Merge identical mutations while keeping each caller's cancellation local. */
  private shareResponse(
    key: string,
    intent: string,
    send: (signal: AbortSignal) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    let active = this.responding.get(key)
    if (active !== undefined) {
      if (active.controller.signal.aborted) return Promise.reject(cancelledResponse())
      if (active.intent !== intent)
        return Promise.reject(
          new AppError({
            code: 'BACKEND_BUSY',
            message: 'A different response to this DSH interaction is already in progress.',
            retryable: false,
          }),
        )
    } else {
      const controller = new AbortController()
      const operation = send(controller.signal)
      const shared: SharedResponse = {
        intent,
        controller,
        promise: operation.finally(() => {
          shared.settled = true
          if (this.responding.get(key) === shared) this.responding.delete(key)
        }),
        callers: 0,
        settled: false,
      }
      this.responding.set(key, shared)
      active = shared
    }
    const shared = active
    shared.callers += 1
    return new Promise<void>((resolve, reject) => {
      let finished = false
      const leave = (): boolean => {
        if (finished) return false
        finished = true
        signal?.removeEventListener('abort', abort)
        shared.callers -= 1
        if (!shared.settled && shared.callers === 0) shared.controller.abort()
        return true
      }
      const abort = (): void => {
        if (leave()) reject(cancelledResponse())
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      // Keep the operation registered until it actually settles: an aborted
      // HTTP result request may already have been accepted by the server.
      // Never turn a caller cancellation into an automatic mutation retry.
      void shared.promise.then(
        () => {
          if (leave()) resolve()
        },
        (error: unknown) => {
          if (leave())
            reject(
              error instanceof Error
                ? error
                : new Error('The interaction response failed.', { cause: error }),
            )
        },
      )
    })
  }

  /** Forget one accepted question batch and report its resolution. */
  private settleQuestion(
    pending: {
      readonly rpcId: string
      readonly sessionId: string
      readonly questionIds: readonly string[]
      readonly question: UserQuestion
    },
    outcome: 'answered' | 'cancelled',
  ): void {
    for (const id of pending.questionIds) {
      this.markAnswered([id])
    }
    this.settlements.accept(pending.question)
    for (const [key, current] of this.questions)
      if (current.rpcId === pending.rpcId && current.sessionId === pending.sessionId)
        this.questions.delete(key)
    this.onSettled?.({
      type: 'question.resolved',
      sessionId: pending.sessionId,
      questionRpcId: pending.rpcId,
      ...(pending.question.callId === undefined ? {} : { settledCallId: pending.question.callId }),
      outcome,
    })
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

function cancelledResponse(): AppError {
  return new AppError({
    code: 'REQUEST_CANCELLED',
    message: 'The DSH interaction response was cancelled.',
    retryable: false,
  })
}

function assertAcceptedReceipt(value: unknown): void {
  if (typeof value !== 'object' || value === null || !('accepted' in value))
    throw malformedInteractionReceipt()
  const receipt = value as { readonly accepted?: unknown; readonly reason?: unknown }
  if (receipt.accepted === true) return
  if (receipt.accepted === false && receipt.reason === 'not-pending') throw staleInteraction('response')
  throw malformedInteractionReceipt()
}

function malformedInteractionReceipt(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed interaction response receipt.',
    retryable: false,
  })
}

function isQuestionAnswer(value: unknown): value is QuestionAnswer {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'response' in value &&
    typeof value.id === 'string' &&
    (!('custom' in value) || value.custom === undefined || typeof value.custom === 'string') &&
    (typeof value.response === 'string' ||
      (Array.isArray(value.response) && value.response.every((entry) => typeof entry === 'string')))
  )
}

function answer(
  entry: QuestionAnswer,
  optionLabels: ReadonlySet<string>,
): {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
} {
  const { response } = entry
  // A string response naming an option is that option's label (rc.6 answers
  // with labels); anything else is free text.
  const rawCustom = typeof response === 'string' && !optionLabels.has(response) ? response : entry.custom
  const custom = rawCustom?.trim()
  const selected =
    typeof response === 'string' ? (optionLabels.has(response) ? [response] : []) : [...response]
  return {
    id: entry.id,
    selected,
    ...(custom !== undefined && custom.length > 0 ? { custom } : {}),
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
  return pending.questionIds.map((id) => {
    const entry = responses.find((candidate) => candidate.id === id)
    if (entry === undefined) throw invalidQuestionAnswer()
    return singleAnswer(entry, pending.items)
  })
}

function singleAnswer(
  entry: QuestionAnswer,
  items: readonly UserQuestionItem[],
): {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
} {
  const item = items.find((candidate) => candidate.id === entry.id)
  if (item === undefined) throw staleInteraction('question item')
  const { response } = entry
  const choices = new Set((item.choices ?? []).map((choice) => choice.id))
  const custom = typeof response === 'string' && !choices.has(response) ? response : entry.custom
  const hasCustom = custom !== undefined && custom.trim().length > 0
  if (hasCustom && item.allowFreeText !== true) throw invalidQuestionAnswer()
  if (typeof response === 'string') {
    // Either a known option label or non-empty free text.
    if (!choices.has(response) && !hasCustom) throw invalidQuestionAnswer()
    if (choices.has(response) && hasCustom && item.multiSelect !== true) throw invalidQuestionAnswer()
  } else {
    if (item.multiSelect !== true && response.length > 1) throw invalidQuestionAnswer()
    if (response.some((value) => !choices.has(value))) throw invalidQuestionAnswer()
    if (hasCustom && item.multiSelect !== true && response.length > 0) throw invalidQuestionAnswer()
  }
  return answer(entry, choices)
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
