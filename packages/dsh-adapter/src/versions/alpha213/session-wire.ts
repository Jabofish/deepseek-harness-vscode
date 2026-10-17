import { recordOrUndefined } from '../../repositories/shared/guards.js'
import { alpha212SessionProfile } from '../alpha212/session-wire.js'
import type { AlphaV4SessionProfile } from '../alpha171/session-wire.js'

/** 2fbf4359b82fb94c03dcce0b831660d87f12ea5c: jobs/src/types.ts.
 * These durable audit facts do not grant execution ownership or replace job/list.
 */
export const alpha213SessionProfile: AlphaV4SessionProfile = {
  ...alpha212SessionProfile,
  eventValidators: {
    ...alpha212SessionProfile.eventValidators,
    'job/registered': validJobRegistration,
    'job/settled': validJobSettlement,
  },
  normalizeEvent(event) {
    if (event.type === 'job/registered' || event.type === 'job/settled')
      return { type: 'system/message', seq: event.seq, time: event.time, data: {} }
    return alpha212SessionProfile.normalizeEvent?.(event) ?? event
  },
}

function validJobRegistration(value: unknown): boolean {
  const job = recordOrUndefined(value)
  if (job === undefined) return false
  const call = recordOrUndefined(job.toolCall)
  return (
    identifier(job.jobId) &&
    identifier(job.owner) &&
    identifier(job.kind) &&
    typeof job.label === 'string' &&
    timestamp(job.startedAt) &&
    (job.toolCall === undefined ||
      (call !== undefined && identifier(call.callId) && identifier(call.rootCallId)))
  )
}

function validJobSettlement(value: unknown): boolean {
  const job = recordOrUndefined(value)
  return (
    job !== undefined &&
    validJobRegistration(job) &&
    timestamp(job.finishedAt) &&
    (job.status === 'completed' || job.status === 'killed' || job.status === 'failed') &&
    (job.cause === 'producer' || job.cause === 'kill' || job.cause === 'teardown') &&
    typeof job.producerReported === 'boolean' &&
    (job.detail === undefined || typeof job.detail === 'string')
  )
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}
