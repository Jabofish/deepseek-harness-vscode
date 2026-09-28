import type { GoalView, JobView } from '@dsh-vscode/domain'

import {
  enumValue,
  nonNegativeSafeNumber,
  object,
  positiveSafeNumber,
  string,
  stringOr,
} from './value-guards.js'
import { recordOrUndefined as objectOrUndefined } from '../../repositories/shared/guards.js'

function goal(value: unknown): GoalView {
  const record = object(value, 'goal')
  const maxGoalRounds =
    record.maxGoalRounds === undefined ? undefined : positiveSafeNumber(record.maxGoalRounds)
  if (record.maxGoalRounds !== undefined && maxGoalRounds === undefined)
    throw new Error('Malformed goal maxGoalRounds')
  const status =
    record.status === undefined
      ? goalPhaseStatus(record.phase)
      : enumValue(record.status, ['pending', 'in-progress', 'completed', 'blocked'] as const, 'pending')
  const blockedReason = goalBlockedReason(record.blockedReason)
  return {
    id: stringOr(record.id, 'goal'),
    title: stringOr(record.title ?? record.objective, 'Goal'),
    status,
    ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
    ...(blockedReason === undefined ? {} : { blockedReason }),
  }
}

/** Keep the host's block reason only when both halves are present and usable. */
function goalBlockedReason(value: unknown): { readonly code: string; readonly message: string } | undefined {
  const record = objectOrUndefined(value)
  if (record === undefined) return undefined
  const code = typeof record.code === 'string' ? record.code : undefined
  const message = typeof record.message === 'string' ? record.message : undefined
  if (code === undefined || code.trim() === '' || message === undefined || message.trim() === '')
    return undefined
  return { code, message }
}

/**
 * Project both the legacy whole-list goal event and the pinned goal/change
 * full-snapshot event into the small GoalView used by the UI. The rc.6 host
 * emits one post-mutation snapshot (or a clear tombstone), never `goals[]`.
 */
export function goalEventGoals(name: string, data: Record<string, unknown>): readonly GoalView[] {
  if (name === 'goal/change') {
    validateCanonicalGoalChange(data)
    if (data.operation === 'clear') {
      return []
    }
    return [goal(data.goal)]
  }
  if (data.cleared === true) return []
  if (Array.isArray(data.goals)) return data.goals.map(goal)
  if (data.goal !== undefined) return [goal(data.goal)]
  return []
}

function validateCanonicalGoalChange(data: Record<string, unknown>): void {
  if (data.kind !== 'goal/change' || data.version !== 1) throw new Error('Malformed goal/change envelope')
  if (data.operation === 'clear') {
    if (!hasOnlyKeys(data, ['cleared', 'clearedAt', 'kind', 'operation', 'version']))
      throw new Error('Malformed goal/change clear tombstone')
    const cleared = objectOrUndefined(data.cleared)
    const clearedAt = nonNegativeSafeNumber(data.clearedAt)
    if (
      cleared === undefined ||
      !hasOnlyKeys(cleared, ['id', 'revision']) ||
      typeof cleared.id !== 'string' ||
      cleared.id.length === 0 ||
      positiveSafeNumber(cleared.revision) === undefined ||
      clearedAt === undefined
    )
      throw new Error('Malformed goal/change clear tombstone')
    return
  }
  if (
    data.operation !== 'create' &&
    data.operation !== 'edit' &&
    data.operation !== 'pause' &&
    data.operation !== 'resume' &&
    data.operation !== 'complete' &&
    data.operation !== 'block'
  )
    throw new Error('Malformed goal/change operation')
  if (!hasOnlyKeys(data, ['createdAt', 'goal', 'kind', 'operation', 'roundsStarted', 'updatedAt', 'version']))
    throw new Error('Malformed goal/change envelope')
  const createdAt = nonNegativeSafeNumber(data.createdAt)
  const updatedAt = nonNegativeSafeNumber(data.updatedAt)
  const roundsStarted = nonNegativeSafeNumber(data.roundsStarted)
  if (
    createdAt === undefined ||
    updatedAt === undefined ||
    roundsStarted === undefined ||
    updatedAt < createdAt
  )
    throw new Error('Malformed goal/change timestamps')
  validateCanonicalGoalSnapshot(data.goal)
}

function validateCanonicalGoalSnapshot(value: unknown): void {
  const record = objectOrUndefined(value)
  if (
    record === undefined ||
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    typeof record.objective !== 'string' ||
    record.objective.trim() === '' ||
    record.objective !== record.objective.trim() ||
    (record.phase !== 'active' &&
      record.phase !== 'paused' &&
      record.phase !== 'blocked' &&
      record.phase !== 'complete') ||
    positiveSafeNumber(record.revision) === undefined ||
    positiveSafeNumber(record.maxGoalRounds) === undefined
  )
    throw new Error('Malformed goal/change goal')
  const expectedKeys =
    record.phase === 'blocked'
      ? ['blockedReason', 'id', 'maxGoalRounds', 'objective', 'phase', 'revision']
      : ['id', 'maxGoalRounds', 'objective', 'phase', 'revision']
  if (!hasOnlyKeys(record, expectedKeys)) throw new Error('Malformed goal/change goal')
  if (record.phase !== 'blocked') return
  const reason = objectOrUndefined(record.blockedReason)
  if (
    reason === undefined ||
    !hasOnlyKeys(reason, ['code', 'message']) ||
    typeof reason.code !== 'string' ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(reason.code) ||
    typeof reason.message !== 'string' ||
    reason.message.trim() === '' ||
    reason.message !== reason.message.trim()
  )
    throw new Error('Malformed goal/change goal')
}

function hasOnlyKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actualKeys = Object.keys(record).sort()
  const expectedKeys = [...expected].sort()
  return (
    actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index])
  )
}

function goalPhaseStatus(value: unknown): GoalView['status'] {
  switch (value) {
    case 'active':
      return 'in-progress'
    case 'paused':
      return 'pending'
    case 'complete':
      return 'completed'
    case 'blocked':
      return 'blocked'
    default:
      return 'pending'
  }
}

export function job(value: unknown): JobView {
  const record = object(value, 'job')
  const status = record.status
  if (
    status !== 'running' &&
    status !== 'stopping' &&
    status !== 'completed' &&
    status !== 'killed' &&
    status !== 'failed'
  )
    throw new Error('Malformed job status')
  const startedAt = nonNegativeSafeNumber(record.startedAt)
  if (startedAt === undefined) throw new Error('Malformed job startedAt')
  const finishedAt = record.finishedAt === undefined ? undefined : nonNegativeSafeNumber(record.finishedAt)
  if (record.finishedAt !== undefined && finishedAt === undefined) throw new Error('Malformed job finishedAt')
  if (record.detail !== undefined && typeof record.detail !== 'string')
    throw new Error('Malformed job detail')
  if (record.progress !== undefined && typeof record.progress !== 'string')
    throw new Error('Malformed job progress')
  const output = record.output === undefined ? undefined : object(record.output, 'job output')
  const outputTotal = output === undefined ? undefined : nonNegativeSafeNumber(output.total)
  const outputEarliest = output === undefined ? undefined : nonNegativeSafeNumber(output.earliest)
  if (
    output !== undefined &&
    (outputTotal === undefined || outputEarliest === undefined || outputEarliest > outputTotal)
  )
    throw new Error('Malformed job output offsets')
  return {
    id: string(record.id, 'job id'),
    kind: string(record.kind, 'job kind'),
    label: string(record.label, 'job label'),
    status,
    ...(record.detail === undefined ? {} : { detail: record.detail }),
    ...(record.progress === undefined ? {} : { progress: record.progress }),
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(outputTotal === undefined || outputEarliest === undefined
      ? {}
      : { output: { total: outputTotal, earliest: outputEarliest } }),
  }
}
