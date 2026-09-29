import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react'
import type { PermissionRequest, QuestionAnswer, UserQuestion } from '@dsh-vscode/domain'
import type { AppStore } from './store.js'
import type { useI18n } from '../i18n.js'
import { approvalCommand } from '../features/interactions/approval-command.js'
import { useStableCallback } from './useStableCallback.js'
import { requestId } from './store/ids.js'
import { object } from './store/unknown-record.js'
import {
  mergeLiveTimedQuestion,
  parseActiveTimedQuestions,
  queuedQuestionReplyCallIds,
  questionFromProjection,
} from './timed-question-projections.js'

/** A pending approval with the command it asks to authorize, when resolvable. */
export interface PendingApproval {
  readonly request: PermissionRequest
  readonly command?: string | undefined
}

interface PendingInteractions {
  readonly pendingPermissions: readonly PendingApproval[]
  readonly pendingQuestions: readonly UserQuestion[]
  readonly approvalRespondFor: (request: PermissionRequest) => (optionId: string) => void
  readonly questionRespondFor: (
    question: UserQuestion,
  ) => (response: string | readonly string[] | readonly QuestionAnswer[]) => Promise<void>
  readonly questionCancelFor: (question: UserQuestion) => () => void
  readonly questionWaitFor: (question: UserQuestion) => {
    readonly attach: () => Promise<number | undefined>
    readonly release: () => Promise<void>
  }
}

const EMPTY_PERMISSION_REQUESTS: readonly PendingApproval[] = []
const EMPTY_USER_QUESTIONS: readonly UserQuestion[] = []
// Per-pending-object handler caches for the memoized interaction cards. They
// live at module scope (never a ref read during render) so the same pending
// object keeps one stable callback identity across streaming frames.
const approvalRespondHandlers = new WeakMap<PermissionRequest, (optionId: string) => void>()
const questionRespondHandlers = new WeakMap<
  UserQuestion,
  (response: string | readonly string[] | readonly QuestionAnswer[]) => Promise<void>
>()
const questionCancelHandlers = new WeakMap<UserQuestion, () => void>()
const questionWaitHandlers = new WeakMap<
  UserQuestion,
  { readonly attach: () => Promise<number | undefined>; readonly release: () => Promise<void> }
>()

export function usePendingInteractions({
  store,
  state,
  activeSessionId,
  setRespondingInteractionId,
  setError,
  t,
}: {
  readonly store: AppStore
  readonly state: ReturnType<AppStore['getState']>
  readonly activeSessionId: string | undefined
  readonly setRespondingInteractionId: Dispatch<SetStateAction<string | undefined>>
  readonly setError: (message: string | undefined) => void
  readonly t: ReturnType<typeof useI18n>['t']
}): PendingInteractions {
  const pendingPermissions = useMemo(
    () =>
      activeSessionId === undefined || state.permissions.length === 0
        ? EMPTY_PERMISSION_REQUESTS
        : state.permissions
            .filter((request) => request.sessionId === activeSessionId)
            .map((request) => ({ request, command: approvalCommand(request, state.timeline.nodes) })),
    [activeSessionId, state.permissions, state.timeline.nodes],
  )
  const sessionProjection = activeSessionId === undefined ? undefined : state.projections[activeSessionId]
  const questionProjection = sessionProjection?.userQuestions
  const inboxProjection = sessionProjection?.inbox
  const activeTimedQuestions = useMemo(
    () => parseActiveTimedQuestions(questionProjection),
    [questionProjection],
  )
  const relevantInboxProjection = useMemo(
    () =>
      activeTimedQuestions?.some((question) => question.state === 'continued') === true
        ? inboxProjection
        : undefined,
    [activeTimedQuestions, inboxProjection],
  )
  const pendingQuestions = useMemo(() => {
    if (activeSessionId === undefined) return EMPTY_USER_QUESTIONS
    const active = activeTimedQuestions
    const queued = queuedQuestionReplyCallIds(relevantInboxProjection)
    const byCallId = new Map((active ?? []).map((question) => [question.callId, question] as const))
    const live = state.questions
      .filter((question) => question.sessionId === activeSessionId)
      .map((question) => {
        const projected =
          (question.callId === undefined ? undefined : byCallId.get(question.callId)) ??
          active?.find((entry) => entry.questions.some((item) => item.id === question.id))
        return projected === undefined
          ? question
          : mergeLiveTimedQuestion(question, projected, queued.has(projected.callId))
      })
      .filter((question) => question.state !== 'continued')
    const recovered = (active ?? [])
      .filter((question) => question.state === 'continued')
      .filter((question) => !live.some((candidate) => candidate.callId === question.callId))
      .map((question) => questionFromProjection(activeSessionId, question, queued.has(question.callId)))
      .filter((question): question is UserQuestion => question !== undefined)
    return [...live, ...recovered]
  }, [activeSessionId, activeTimedQuestions, relevantInboxProjection, state.questions])
  // The pending cards are memoized against streaming frames, so their handlers
  // must not be inline closures: they are dispatched through stable per-id
  // callbacks and cached per pending object, keeping the card props identical
  // from frame to frame.
  const respondToPermissionById = useStableCallback((requestId: string, optionId: string): void => {
    setRespondingInteractionId(requestId)
    void store
      .respondToPermission(requestId, optionId)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.answerApproval')),
      )
      .finally(() => setRespondingInteractionId(undefined))
  })
  const respondToQuestionById = useStableCallback(
    async (
      question: UserQuestion,
      response: string | readonly string[] | readonly QuestionAnswer[],
    ): Promise<void> => {
      const interactionId = question.callId ?? question.id
      setRespondingInteractionId(interactionId)
      try {
        if (question.state === 'continued' && question.callId !== undefined) {
          const answers =
            typeof response === 'string'
              ? [{ id: question.id, selected: [response] }]
              : isStructuredQuestionAnswerBatch(response)
                ? response.map((answer) => {
                    const item = {
                      id: answer.id,
                      selected:
                        typeof answer.response === 'string' ? [answer.response] : [...answer.response],
                    }
                    return answer.custom === undefined ? item : { ...item, custom: answer.custom }
                  })
                : [{ id: question.id, selected: [...response] }]
          const result = object(
            await store.featureRequest<unknown>({
              type: 'user-question.answer',
              requestId: requestId(),
              payload: { sessionId: question.sessionId, callId: question.callId, answer: { answers } },
            }),
          )
          if (result?.kind !== 'question.answer' || result.accepted !== true)
            throw new Error(t('question.answerNoLongerPending'))
        } else {
          await store.respondToQuestion(question.id, response)
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : t('app.error.answerQuestion'))
        throw reason
      } finally {
        setRespondingInteractionId(undefined)
      }
    },
  )
  const cancelQuestionById = useStableCallback((questionId: string): void => {
    setRespondingInteractionId(questionId)
    void store
      .cancelQuestion(questionId)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.cancelQuestion')),
      )
      .finally(() => setRespondingInteractionId(undefined))
  })
  const approvalRespondFor = useCallback(
    (request: PermissionRequest): ((optionId: string) => void) => {
      let handler = approvalRespondHandlers.get(request)
      if (handler === undefined) {
        handler = (optionId: string) => respondToPermissionById(request.id, optionId)
        approvalRespondHandlers.set(request, handler)
      }
      return handler
    },
    [respondToPermissionById],
  )
  const questionRespondFor = useCallback(
    (
      question: UserQuestion,
    ): ((response: string | readonly string[] | readonly QuestionAnswer[]) => Promise<void>) => {
      let handler = questionRespondHandlers.get(question)
      if (handler === undefined) {
        handler = (response) => respondToQuestionById(question, response)
        questionRespondHandlers.set(question, handler)
      }
      return handler
    },
    [respondToQuestionById],
  )
  const questionCancelFor = useCallback(
    (question: UserQuestion): (() => void) => {
      let handler = questionCancelHandlers.get(question)
      if (handler === undefined) {
        handler = () => cancelQuestionById(question.id)
        questionCancelHandlers.set(question, handler)
      }
      return handler
    },
    [cancelQuestionById],
  )
  const attachTimedQuestionWait = useStableCallback(
    async (question: UserQuestion): Promise<number | undefined> => {
      if (question.callId === undefined) return undefined
      const result = object(
        await store.featureRequest<unknown>({
          type: 'user-question.wait.attach',
          requestId: requestId(),
          payload: { sessionId: question.sessionId, callId: question.callId },
        }),
      )
      if (result?.kind !== 'question.wait') throw new Error(t('question.waitUnavailable'))
      if (result.remainingMs === null) return undefined
      if (
        typeof result.remainingMs !== 'number' ||
        !Number.isSafeInteger(result.remainingMs) ||
        result.remainingMs < 0 ||
        result.remainingMs > 2_147_483_647
      )
        throw new Error(t('question.waitUnavailable'))
      return result.remainingMs
    },
  )
  const releaseTimedQuestionWait = useStableCallback(async (question: UserQuestion): Promise<void> => {
    if (question.callId === undefined) return
    await store.featureRequest<unknown>({
      type: 'user-question.wait.release',
      requestId: requestId(),
      payload: { sessionId: question.sessionId, callId: question.callId },
    })
  })
  const questionWaitFor = useCallback(
    (question: UserQuestion) => {
      let handlers = questionWaitHandlers.get(question)
      if (handlers === undefined) {
        handlers = {
          attach: () => attachTimedQuestionWait(question),
          release: () => releaseTimedQuestionWait(question).catch(() => undefined),
        }
        questionWaitHandlers.set(question, handlers)
      }
      return handlers
    },
    [attachTimedQuestionWait, releaseTimedQuestionWait],
  )
  return {
    pendingPermissions,
    pendingQuestions,
    approvalRespondFor,
    questionRespondFor,
    questionCancelFor,
    questionWaitFor,
  }
}

function isStructuredQuestionAnswerBatch(
  response: readonly string[] | readonly QuestionAnswer[],
): response is readonly QuestionAnswer[] {
  const first = response[0]
  return first !== undefined && typeof first === 'object'
}
