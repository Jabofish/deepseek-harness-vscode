import { isRecord } from './unknown-record.js'
import {
  finiteEventIndex,
  isJobView,
  isWorkflowMember,
  isWorkflowSummary,
  nonEmptyString,
  nonNegativeSafeInteger,
  parseGoalViews,
  parseQueuedInputs,
  parseTeamActivity,
  parseTodoViews,
  positiveSafeInteger,
  projectionAsOfSequence,
} from './event-values.js'
import { jobFollowUpdatedPayloadSchema, jobFollowFailedPayloadSchema } from '@dsh-vscode/webview-protocol'

import type { BackendEvent } from '@dsh-vscode/domain'

/** Branches are matched by event name; the caller owns the name-mutual-exclusion ordering. */
export function parseWorkflowTeamEvents(
  name: string,
  value: Record<string, unknown>,
  payload: unknown,
): BackendEvent | null | undefined {
  if (name === 'team.updated' && nonEmptyString(value.sessionId)) {
    const activity = parseTeamActivity(value.activity)
    return activity === undefined
      ? { type: 'unknown', sessionId: value.sessionId, name, payload }
      : { type: 'team.updated', sessionId: value.sessionId, activity }
  }
  if (name === 'goal.updated' && nonEmptyString(value.sessionId)) {
    const goals = parseGoalViews(value.goals)
    if (goals !== undefined) return { type: 'goal.updated', sessionId: value.sessionId, goals }
  }
  if (name === 'todo.updated' && nonEmptyString(value.sessionId)) {
    const todos = parseTodoViews(value.todos)
    if (todos !== undefined) return { type: 'todo.updated', sessionId: value.sessionId, todos }
  }
  if (
    name === 'compaction.updated' &&
    nonEmptyString(value.sessionId) &&
    isRecord(value.compaction) &&
    nonEmptyString(value.compaction.id)
  ) {
    const phase = value.compaction.phase
    const summary = value.compaction.summary
    const replacedCount = value.compaction.replacedCount
    const estimatedTokens = value.compaction.estimatedTokens
    const parsedReplacedCount = nonNegativeSafeInteger(replacedCount)
    const parsedEstimatedTokens = nonNegativeSafeInteger(estimatedTokens)
    if (
      (phase !== 'start' && phase !== 'summary' && phase !== 'prune' && phase !== 'end') ||
      (summary !== undefined && typeof summary !== 'string') ||
      (replacedCount !== undefined && parsedReplacedCount === undefined) ||
      (estimatedTokens !== undefined && parsedEstimatedTokens === undefined)
    )
      return { type: 'unknown', sessionId: value.sessionId, name, payload }
    return {
      type: 'compaction.updated',
      sessionId: value.sessionId,
      compaction: {
        id: value.compaction.id,
        phase,
        ...(summary === undefined ? {} : { summary }),
        ...(parsedReplacedCount === undefined ? {} : { replacedCount: parsedReplacedCount }),
        ...(parsedEstimatedTokens === undefined ? {} : { estimatedTokens: parsedEstimatedTokens }),
      },
    }
  }
  if (name === 'model.retry' && isRecord(value.retry)) {
    const retry = value.retry
    const turn = finiteEventIndex(retry.turn)
    const step = finiteEventIndex(retry.step)
    const attempt = positiveSafeInteger(retry.attempt)
    const delayMs = retry.delayMs === undefined ? undefined : nonNegativeSafeInteger(retry.delayMs)
    const maxRetries = retry.maxRetries === undefined ? undefined : positiveSafeInteger(retry.maxRetries)
    if (
      nonEmptyString(retry.sessionId) &&
      nonEmptyString(retry.id) &&
      turn !== undefined &&
      step !== undefined &&
      attempt !== undefined &&
      (retry.delayMs === undefined || delayMs !== undefined) &&
      (retry.maxRetries === undefined || maxRetries !== undefined) &&
      (retry.message === undefined || typeof retry.message === 'string') &&
      (retry.state === 'scheduled' || retry.state === 'started')
    )
      return {
        type: 'model.retry',
        retry: {
          sessionId: retry.sessionId,
          id: retry.id,
          turn,
          step,
          attempt,
          state: retry.state,
          ...(delayMs === undefined ? {} : { delayMs }),
          ...(maxRetries === undefined ? {} : { maxRetries }),
          ...(typeof retry.message === 'string' ? { message: retry.message } : {}),
        },
      }
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
  if (name === 'workflow.started' && nonEmptyString(value.sessionId) && isWorkflowSummary(value.workflow))
    return {
      type: 'workflow.started',
      sessionId: value.sessionId,
      workflow: value.workflow,
    }
  if (
    name === 'workflow.member.started' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.runId) &&
    (typeof value.phase === 'string' || value.phase === null) &&
    isWorkflowMember(value.member) &&
    value.member.status === 'running'
  )
    return {
      type: 'workflow.member.started',
      sessionId: value.sessionId,
      runId: value.runId,
      phase: value.phase,
      member: value.member,
    }
  if (
    name === 'workflow.member.ended' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.runId) &&
    Number.isSafeInteger(value.seq) &&
    (value.seq as number) > 0 &&
    (value.outcome === 'completed' || value.outcome === 'failed' || value.outcome === 'cancelled')
  )
    return {
      type: 'workflow.member.ended',
      sessionId: value.sessionId,
      runId: value.runId,
      seq: value.seq as number,
      outcome: value.outcome,
    }
  if (
    name === 'workflow.ended' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.runId) &&
    (value.stopReason === 'completed' || value.stopReason === 'cancelled' || value.stopReason === 'error')
  )
    return {
      type: 'workflow.ended',
      sessionId: value.sessionId,
      runId: value.runId,
      stopReason: value.stopReason,
    }
  return undefined
}
