import type { UserQuestionItem } from './tools.js'

/** Structured answer item accepted by DSH's timed question Remote. */
export interface TimedUserQuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** One complete batch for a timed ask_user_question call. */
export interface TimedUserQuestionAnswer {
  readonly answers: readonly TimedUserQuestionAnswerItem[]
}

export type TimedUserQuestionState = 'open' | 'continued'

export interface TimedPendingUserQuestion {
  readonly callId: string
  readonly questions: readonly UserQuestionItem[]
  readonly state: TimedUserQuestionState
}

export interface TimedSettledUserQuestion {
  readonly callId: string
  readonly answers: readonly TimedUserQuestionAnswerItem[]
}

/** DSH's durable projection for timed ask_user_question calls. */
export interface TimedUserQuestionProjection {
  readonly active: readonly TimedPendingUserQuestion[]
  readonly settled: readonly TimedSettledUserQuestion[]
}

/** Safe transcript projection of a persisted late reply message. */
export interface UserQuestionReplyView {
  readonly callId: string
  readonly questions: readonly UserQuestionItem[]
  readonly answers: readonly TimedUserQuestionAnswerItem[]
}

/** Exact rc.2 Remote boundary; stream claims stay owned by the adapter. */
export interface UserQuestionRepository {
  attachWait(sessionId: string, callId: string, signal?: AbortSignal): Promise<number | undefined>
  releaseWait(sessionId: string, callId: string): Promise<void>
  answer(
    sessionId: string,
    callId: string,
    answer: TimedUserQuestionAnswer,
    signal?: AbortSignal,
  ): Promise<boolean>
  close(): Promise<void>
}
