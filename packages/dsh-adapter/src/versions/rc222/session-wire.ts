import { recordOrUndefined } from '../../repositories/shared/guards.js'
import { alpha222SessionProfile } from '../alpha222/session-wire.js'
import type { AlphaV4SessionProfile } from '../alpha171/session-wire.js'
import { validCatalogFact } from '../alpha211/session-wire.js'
import { rc222CatalogFactSchema, rc222TeamModeSchema } from './contracts.js'
import { restoreRc222Artifact } from './session-artifact.js'

const teamAuditEvents = new Set([
  'team/mode',
  'team/member',
  'team/task',
  'team/message/queued',
  'team/message/delivered',
])

/** Released rc.2 V4 vocabulary and catalog relationships over the row codec. */
export const rc222SessionProfile: AlphaV4SessionProfile = {
  ...alpha222SessionProfile,
  restoreArtifact: restoreRc222Artifact,
  eventValidators: {
    ...alpha222SessionProfile.eventValidators,
    'subagent/catalog': (value) =>
      validCatalogFact(value, true) || rc222CatalogFactSchema.safeParse(value).success,
    'team/mode': (value) => rc222TeamModeSchema.safeParse(value).success,
  },
  normalizeEvent(event) {
    const data = recordOrUndefined(event.data)
    if (typeof event.type === 'string' && teamAuditEvents.has(event.type))
      return { type: 'system/message', seq: event.seq, time: event.time, data: {} }
    if (event.type === 'subagent/catalog' && data?.version === 3) {
      // The existing fact only invalidates the catalog. Names come from its
      // authoritative projection when the repository refreshes the roster.
      const { name, ...identity } = data
      void name
      const compatible = {
        ...event,
        data: { ...identity, version: data.mode === 'external' ? 2 : 0 },
      }
      return alpha222SessionProfile.normalizeEvent?.(compatible) ?? compatible
    }
    return alpha222SessionProfile.normalizeEvent?.(event) ?? event
  },
}
