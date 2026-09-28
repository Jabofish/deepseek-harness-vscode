import { isRecord } from './unknown-record.js'
import { nonEmptyString, parsePermissionRequest, parseUserQuestion } from './event-values.js'

import type { BackendEvent } from '@dsh-vscode/domain'

/** Branches are matched by event name; the caller owns the name-mutual-exclusion ordering. */
export function parseInteractionEvents(
  name: string,
  value: Record<string, unknown>,
  _payload: unknown,
): BackendEvent | undefined {
  if (name === 'permission.requested' && isRecord(value.request)) {
    const request = parsePermissionRequest(value.request)
    if (request !== undefined) return { type: 'permission.requested', request }
  }
  if (name === 'question.requested' && isRecord(value.question)) {
    const question = parseUserQuestion(value.question)
    if (question !== undefined) return { type: 'question.requested', question }
  }
  if (name === 'permission.resolved') {
    const hasOutcome = Object.hasOwn(value, 'outcome')
    if (
      nonEmptyString(value.sessionId) &&
      nonEmptyString(value.requestId) &&
      (!hasOutcome || typeof value.outcome === 'string')
    )
      return {
        type: 'permission.resolved',
        sessionId: value.sessionId,
        requestId: value.requestId,
        ...(typeof value.outcome === 'string' ? { outcome: value.outcome } : {}),
      }
  }
  if (name === 'question.resolved') {
    const hasQuestionRpcId = Object.hasOwn(value, 'questionRpcId')
    const hasQuestionId = Object.hasOwn(value, 'questionId')
    const questionRpcId =
      hasQuestionRpcId && nonEmptyString(value.questionRpcId) ? value.questionRpcId : undefined
    const questionId = hasQuestionId && nonEmptyString(value.questionId) ? value.questionId : undefined
    const hasOutcome = Object.hasOwn(value, 'outcome')
    if (
      nonEmptyString(value.sessionId) &&
      (!hasQuestionRpcId || questionRpcId !== undefined) &&
      (!hasQuestionId || questionId !== undefined) &&
      (questionRpcId !== undefined || questionId !== undefined) &&
      (!hasOutcome || typeof value.outcome === 'string')
    )
      return {
        type: 'question.resolved',
        sessionId: value.sessionId,
        ...(questionRpcId === undefined ? {} : { questionRpcId }),
        ...(questionId === undefined ? {} : { questionId }),
        ...(typeof value.outcome === 'string' ? { outcome: value.outcome } : {}),
      }
  }
  return undefined
}
