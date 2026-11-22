import { z } from 'zod'
import { recordOrUndefined } from '../../repositories/shared/guards.js'
import type { AlphaV4SessionProfile } from '../alpha171/session-wire.js'
import { rc222SessionProfile } from '../rc222/session-wire.js'

const actionCardDecision = z.strictObject({
  cardId: z.string().min(1),
  action: z.string().min(1),
  phase: z.string().min(1),
  data: z.record(z.string(), z.json()).optional(),
})

export const alpha231SessionProfile: AlphaV4SessionProfile = {
  ...rc222SessionProfile,
  eventValidators: {
    ...rc222SessionProfile.eventValidators,
    'workspace-root/change': rc222SessionProfile.eventValidators['working-directory/change']!,
    'action-cards/decision': (value) => actionCardDecision.safeParse(value).success,
  },
  normalizeEvent(event) {
    if (event.type === 'working-directory/change' || event.type === 'action-cards/decision')
      return { type: 'system/message', seq: event.seq, time: event.time, data: {} }
    if (event.type === 'workspace-root/change')
      return {
        ...event,
        type: 'session/projection',
        data: { key: 'workingDirectory', value: recordOrUndefined(event.data)?.cwd, seq: event.seq },
      }
    return rc222SessionProfile.normalizeEvent?.(event) ?? event
  },
}
