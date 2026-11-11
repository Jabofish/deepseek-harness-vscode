import type { SessionProjectionSnapshot, SessionProjectionValues } from '@dsh-vscode/domain'
import { catalogEntries } from '../alpha211/subagent-repository.js'
import {
  masterSequence,
  masterTeamProjectionSchema,
  parseMasterContract,
  parseMasterContinuation,
} from './contracts.js'

/** Input values have already passed the inherited version's Domain mapping. */
export function mapMasterPublicProjectionValues(values: SessionProjectionValues): SessionProjectionValues {
  if (Object.hasOwn(values, 'conversationContinuation'))
    parseMasterContract(
      masterSequence.nullable(),
      values.conversationContinuation,
      'conversationContinuation',
    )
  if (Object.hasOwn(values, 'subagentCatalog')) catalogEntries(values, true, true)
  if (!Object.hasOwn(values, 'agentTeam')) return values
  parseMasterContract(masterTeamProjectionSchema, values.agentTeam, 'agentTeam')
  // Team scopes and diagnostics are read through the explicitly Host-only client.
  const { agentTeam, ...publicValues } = values
  void agentTeam
  return publicValues
}

export function mapMasterPublicProjection(projection: SessionProjectionSnapshot): SessionProjectionSnapshot {
  if (Object.hasOwn(projection.values, 'conversationContinuation'))
    parseMasterContinuation(projection.values.conversationContinuation, projection.asOfSequence)
  return { ...projection, values: mapMasterPublicProjectionValues(projection.values) }
}
