import type { BackendEvent } from '@dsh-vscode/domain'
import { jobFollowUpdatedPayloadSchema, jobFollowFailedPayloadSchema } from '@dsh-vscode/webview-protocol'
import {
  finiteEventIndex,
  isJobView,
  nonEmptyString,
  parseGoalViews,
  parseQueuedInputs,
  projectionAsOfSequence,
  turnEndFailure,
  turnEndReason,
} from './event-values.js'

/** Whole upstream control values and turn completion notifications; no transcript fold. */
export function parseControlEvents(
  name: string,
  value: Record<string, unknown>,
  payload: unknown,
): BackendEvent | null | undefined {
  if (name === 'goal.updated' && nonEmptyString(value.sessionId)) {
    const goals = parseGoalViews(value.goals)
    if (goals !== undefined) return { type: 'goal.updated', sessionId: value.sessionId, goals }
  }
  if (
    name === 'jobs.updated' &&
    nonEmptyString(value.sessionId) &&
    Array.isArray(value.jobs) &&
    value.jobs.every(isJobView)
  ) {
    return {
      type: 'jobs.updated',
      sessionId: value.sessionId,
      jobs: value.jobs,
    }
  }
  if (name === 'job.follow.updated') {
    const result = jobFollowUpdatedPayloadSchema.safeParse(value)
    if (result.success)
      return {
        type: 'job.follow.updated',
        sessionId: result.data.sessionId,
        jobId: result.data.jobId,
        followId: result.data.followId,
        frame: result.data.frame,
      }
  }
  if (name === 'job.follow.failed') {
    const result = jobFollowFailedPayloadSchema.safeParse(value)
    if (result.success)
      return {
        type: 'job.follow.failed',
        sessionId: result.data.sessionId,
        jobId: result.data.jobId,
        followId: result.data.followId,
        reason: 'stream-failed',
      }
  }
  if (name === 'queue.updated' && nonEmptyString(value.sessionId)) {
    const hasAsOfSequence = Object.hasOwn(value, 'asOfSequence')
    const asOfSequence = hasAsOfSequence ? projectionAsOfSequence(value.asOfSequence) : undefined
    if (hasAsOfSequence && (asOfSequence === undefined || asOfSequence < 0 || Object.is(asOfSequence, -0)))
      return null
    const items = parseQueuedInputs(value.items, value.sessionId)
    if (items !== undefined)
      return {
        type: 'queue.updated',
        sessionId: value.sessionId,
        items,
        ...(asOfSequence === undefined ? {} : { asOfSequence }),
      }
  }
  if ((name === 'turn.started' || name === 'turn.ended') && nonEmptyString(value.sessionId)) {
    const turn = finiteEventIndex(value.turn)
    if (turn === undefined) return { type: 'unknown', name, payload }
    if (name === 'turn.started') return { type: 'turn.started', sessionId: value.sessionId, turn }
    const hasFailure = Object.hasOwn(value, 'failure')
    const failure = turnEndFailure(value.failure ?? value.reason)
    if (hasFailure && failure === undefined) return { type: 'unknown', name, payload }
    return {
      type: 'turn.ended',
      sessionId: value.sessionId,
      turn,
      reason: turnEndReason(value.reason),
      ...(failure === undefined ? {} : { failure }),
    }
  }
  if (name === 'remote.event' && nonEmptyString(value.name) && Array.isArray(value.args))
    return { type: 'remote.event', name: value.name, args: value.args }
  if (name === 'connection.lost' && typeof value.reason === 'string')
    return { type: 'connection.lost', reason: value.reason }
  return undefined
}
