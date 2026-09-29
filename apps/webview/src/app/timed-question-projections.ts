import type {
  QuestionChoice,
  TimedPendingUserQuestion,
  UserQuestion,
  UserQuestionItem,
} from '@dsh-vscode/domain'

import { object } from './store/unknown-record.js'

/** Parse only the bounded active half needed to recover answerable cards. */
export function parseActiveTimedQuestions(value: unknown): readonly TimedPendingUserQuestion[] | undefined {
  const projection = object(value)
  if (projection === undefined || !Array.isArray(projection.active) || projection.active.length > 256)
    return undefined
  const questions: TimedPendingUserQuestion[] = []
  const callIds = new Set<string>()
  for (const entry of projection.active) {
    const pending = object(entry)
    if (
      pending === undefined ||
      !nonEmptyString(pending.callId) ||
      callIds.has(pending.callId) ||
      (pending.state !== 'open' && pending.state !== 'continued') ||
      !Array.isArray(pending.questions) ||
      pending.questions.length === 0 ||
      pending.questions.length > 64
    )
      return undefined
    const items = pending.questions.map(projectedQuestion)
    if (items.some((item) => item === undefined)) return undefined
    callIds.add(pending.callId)
    questions.push({
      callId: pending.callId,
      state: pending.state,
      questions: items as readonly UserQuestionItem[],
    })
  }
  return questions
}

export function questionFromProjection(
  sessionId: string,
  pending: TimedPendingUserQuestion,
  replyQueued: boolean,
): UserQuestion | undefined {
  const first = pending.questions[0]
  if (first === undefined) return undefined
  const items = pending.questions.map((item) => ({ ...item, allowFreeText: true }))
  return {
    id: pending.callId,
    sessionId,
    callId: pending.callId,
    prompt: first.prompt,
    ...(first.detail === undefined ? {} : { detail: first.detail }),
    ...(first.header === undefined ? {} : { header: first.header }),
    ...(first.choices === undefined ? {} : { choices: first.choices }),
    ...(first.multiSelect === undefined ? {} : { multiSelect: first.multiSelect }),
    allowFreeText: true,
    items,
    timed: true,
    state: pending.state,
    ...(replyQueued ? { replyQueued: true } : {}),
  }
}

/** Merge durable state without inventing a live timeout claim for `timeout: -1`. */
export function mergeLiveTimedQuestion(
  question: UserQuestion,
  pending: TimedPendingUserQuestion,
  replyQueued: boolean,
): UserQuestion {
  return {
    ...question,
    callId: pending.callId,
    state: pending.state,
    ...(replyQueued ? { replyQueued: true } : {}),
  }
}

/** Read the exact Inbox message source used to make a queued late reply read-only. */
export function queuedQuestionReplyCallIds(value: unknown): ReadonlySet<string> {
  const inbox = object(value)
  if (inbox === undefined) return new Set()
  const callIds = new Set<string>()
  for (const key of ['next-step', 'next-turn'] as const) {
    const messages = inbox[key]
    if (!Array.isArray(messages)) continue
    for (const entry of messages) {
      const message = object(entry)
      const source = object(message?.source)
      if (source?.kind === 'user-question-reply' && nonEmptyString(source.callId)) callIds.add(source.callId)
    }
  }
  return callIds
}

function projectedQuestion(value: unknown): UserQuestionItem | undefined {
  const question = object(value)
  if (
    question === undefined ||
    !nonEmptyString(question.id) ||
    !boundedString(question.prompt) ||
    (question.detail !== undefined && !boundedString(question.detail)) ||
    (question.header !== undefined && !boundedString(question.header)) ||
    typeof question.allowFreeText !== 'boolean' ||
    (question.multiSelect !== undefined && typeof question.multiSelect !== 'boolean') ||
    (question.choices !== undefined && !Array.isArray(question.choices))
  )
    return undefined
  const choices: QuestionChoice[] = []
  for (const entry of (question.choices as readonly unknown[] | undefined) ?? []) {
    const option = object(entry)
    if (
      option === undefined ||
      !boundedString(option.id) ||
      !boundedString(option.label) ||
      (option.description !== undefined && !boundedString(option.description))
    )
      return undefined
    choices.push({
      id: option.id,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    })
  }
  return {
    id: question.id,
    prompt: question.prompt,
    ...(question.detail === undefined ? {} : { detail: question.detail }),
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(choices.length === 0 ? {} : { choices }),
    ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
    allowFreeText: question.allowFreeText,
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 512
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100_000
}
