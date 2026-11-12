import type { SessionProjectionSnapshot, SessionProjectionValues } from '@dsh-vscode/domain'
import { catalogEntries } from '../alpha211/subagent-repository.js'
import {
  rc222Sequence,
  rc222TeamProjectionSchema,
  parseRc222Contract,
  parseRc222Continuation,
} from './contracts.js'

/** Input values have already passed the inherited version's Domain mapping. */
export function mapRc222PublicProjectionValues(values: SessionProjectionValues): SessionProjectionValues {
  if (Object.hasOwn(values, 'conversationContinuation'))
    parseRc222Contract(rc222Sequence.nullable(), values.conversationContinuation, 'conversationContinuation')
  if (Object.hasOwn(values, 'subagentCatalog')) catalogEntries(values, true, true)
  if (!Object.hasOwn(values, 'agentTeam')) return values
  parseRc222Contract(rc222TeamProjectionSchema, values.agentTeam, 'agentTeam')
  // Team scopes and diagnostics must not cross the public projection boundary.
  const { agentTeam, ...publicValues } = values
  void agentTeam
  return publicValues
}

export function mapRc222PublicProjection(projection: SessionProjectionSnapshot): SessionProjectionSnapshot {
  if (Object.hasOwn(projection.values, 'conversationContinuation'))
    parseRc222Continuation(projection.values.conversationContinuation, projection.asOfSequence)
  return { ...projection, values: mapRc222PublicProjectionValues(projection.values) }
}
