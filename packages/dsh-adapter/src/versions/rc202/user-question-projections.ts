import { AppError, type BackendEvent, type SessionProjectionValues } from '@dsh-vscode/domain'
import type {
  TimedUserQuestionAnswerItem,
  TimedUserQuestionProjection,
  UserQuestionItem,
} from '@dsh-vscode/domain'

const MAX_ACTIVE_CALLS = 256
const MAX_SETTLED_CALLS = 10_000
const MAX_QUESTIONS_PER_CALL = 64
const MAX_OPTIONS_PER_QUESTION = 64
const MAX_ANSWERS_PER_CALL = 64
const MAX_STRING_LENGTH = 100_000

/** Convert only the rc.2 projection vocabulary into a bounded domain DTO. */
export function mapRc202UserQuestionProjection(value: unknown): TimedUserQuestionProjection {
  if (!isRecord(value) || !hasExactKeys(value, ['active', 'settled'])) throw malformed()
  if (
    !Array.isArray(value.active) ||
    value.active.length > MAX_ACTIVE_CALLS ||
    !Array.isArray(value.settled) ||
    value.settled.length > MAX_SETTLED_CALLS
  )
    throw malformed()

  const activeCallIds = new Set<string>()
  const active = value.active.map((entry): TimedUserQuestionProjection['active'][number] => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['callId', 'questions', 'state']) ||
      !nonEmptyString(entry.callId) ||
      (entry.state !== 'open' && entry.state !== 'continued') ||
      !Array.isArray(entry.questions) ||
      entry.questions.length === 0 ||
      entry.questions.length > MAX_QUESTIONS_PER_CALL ||
      activeCallIds.has(entry.callId)
    )
      throw malformed()

    const questionIds = new Set<string>()
    const questions = entry.questions.map((question): UserQuestionItem => {
      if (
        !isRecord(question) ||
        !hasExactKeys(question, ['id', 'question', 'detail', 'header', 'options', 'multiSelect']) ||
        !nonEmptyString(question.id) ||
        questionIds.has(question.id) ||
        !boundedString(question.question) ||
        (question.detail !== undefined && !boundedString(question.detail)) ||
        (question.header !== undefined && !boundedString(question.header)) ||
        (question.multiSelect !== undefined && typeof question.multiSelect !== 'boolean') ||
        (question.options !== undefined &&
          (!Array.isArray(question.options) || question.options.length > MAX_OPTIONS_PER_QUESTION))
      )
        throw malformed()

      questionIds.add(question.id)
      const choices = question.options?.map((option) => {
        if (
          !isRecord(option) ||
          !hasExactKeys(option, ['label', 'description']) ||
          !boundedString(option.label) ||
          (option.description !== undefined && !boundedString(option.description))
        )
          throw malformed()
        return {
          id: option.label,
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        }
      })

      return {
        id: question.id,
        prompt: question.question,
        ...(question.detail === undefined ? {} : { detail: question.detail }),
        ...(question.header === undefined ? {} : { header: question.header }),
        ...(choices === undefined || choices.length === 0 ? {} : { choices }),
        ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
        allowFreeText: true,
      }
    })

    activeCallIds.add(entry.callId)
    return { callId: entry.callId, state: entry.state, questions }
  })

  const settledCallIds = new Set<string>()
  const settled = value.settled.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['callId', 'answers']) ||
      !nonEmptyString(entry.callId) ||
      settledCallIds.has(entry.callId) ||
      !Array.isArray(entry.answers) ||
      entry.answers.length > MAX_ANSWERS_PER_CALL
    )
      throw malformed()
    settledCallIds.add(entry.callId)
    return { callId: entry.callId, answers: entry.answers.map(mapAnswer) }
  })

  return { active, settled }
}

/** Normalize the one rc.2-only key without changing other versioned projection DTOs. */
export function mapRc202ProjectionValues(values: Readonly<Record<string, unknown>>): SessionProjectionValues {
  if (!Object.hasOwn(values, 'userQuestions')) return values
  return { ...values, userQuestions: mapRc202UserQuestionProjection(values.userQuestions) }
}

export function mapRc202BackendEvent(event: BackendEvent): BackendEvent {
  if (event.type === 'session.projection' && event.key === 'userQuestions')
    return { ...event, value: mapRc202UserQuestionProjection(event.value) }
  if (event.type === 'session.subscribed' && event.projection !== undefined)
    return {
      ...event,
      projection: {
        ...event.projection,
        values: mapRc202ProjectionValues(event.projection.values),
      },
    }
  if (event.type === 'session.projection.baseline')
    return {
      ...event,
      projections: Object.fromEntries(
        Object.entries(event.projections).map(([sessionId, projection]) => [
          sessionId,
          { ...projection, values: mapRc202ProjectionValues(projection.values) },
        ]),
      ),
    }
  return event
}

function mapAnswer(value: unknown): TimedUserQuestionAnswerItem {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'selected', 'custom']) ||
    !nonEmptyString(value.id) ||
    !Array.isArray(value.selected) ||
    value.selected.length > MAX_OPTIONS_PER_QUESTION ||
    !value.selected.every(boundedString) ||
    (value.custom !== undefined && !boundedString(value.custom))
  )
    throw malformed()
  return {
    id: value.id,
    selected: value.selected,
    ...(value.custom === undefined ? {} : { custom: value.custom }),
  }
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 512
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_STRING_LENGTH
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformed(): Error {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed 0.2.0-rc.2 user question projection.',
    retryable: false,
  })
}
