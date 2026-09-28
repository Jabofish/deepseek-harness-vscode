import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react'
import type { PermissionRequest, QuestionAnswer, UserQuestion } from '@dsh-vscode/domain'
import type { AppStore } from './store.js'
import type { useI18n } from '../i18n.js'
import { approvalCommand } from '../features/interactions/approval-command.js'
import { useStableCallback } from './useStableCallback.js'

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
  ) => (response: string | readonly string[] | readonly QuestionAnswer[]) => void
  readonly questionCancelFor: (question: UserQuestion) => () => void
}

const EMPTY_PERMISSION_REQUESTS: readonly PendingApproval[] = []
const EMPTY_USER_QUESTIONS: readonly UserQuestion[] = []
// Per-pending-object handler caches for the memoized interaction cards. They
// live at module scope (never a ref read during render) so the same pending
// object keeps one stable callback identity across streaming frames.
const approvalRespondHandlers = new WeakMap<PermissionRequest, (optionId: string) => void>()
const questionRespondHandlers = new WeakMap<
  UserQuestion,
  (response: string | readonly string[] | readonly QuestionAnswer[]) => void
>()
const questionCancelHandlers = new WeakMap<UserQuestion, () => void>()

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
  const pendingQuestions = useMemo(
    () =>
      activeSessionId === undefined || state.questions.length === 0
        ? EMPTY_USER_QUESTIONS
        : state.questions.filter((question) => question.sessionId === activeSessionId),
    [activeSessionId, state.questions],
  )
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
    (questionId: string, response: string | readonly string[] | readonly QuestionAnswer[]): void => {
      setRespondingInteractionId(questionId)
      void store
        .respondToQuestion(questionId, response)
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : t('app.error.answerQuestion')),
        )
        .finally(() => setRespondingInteractionId(undefined))
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
    ): ((response: string | readonly string[] | readonly QuestionAnswer[]) => void) => {
      let handler = questionRespondHandlers.get(question)
      if (handler === undefined) {
        handler = (response) => respondToQuestionById(question.id, response)
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
  return { pendingPermissions, pendingQuestions, approvalRespondFor, questionRespondFor, questionCancelFor }
}
