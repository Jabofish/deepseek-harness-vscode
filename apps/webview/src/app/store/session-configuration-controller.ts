import type { AgentConfiguration } from '@dsh-vscode/domain'
import type { ProtocolClient } from '../protocol-client.js'
import type { AppState, StateSetter } from './types.js'
import { requestId } from './ids.js'

export type PresetSessionSyncTarget =
  | {
      readonly kind: 'active'
      readonly sessionId: string
      readonly configuration: AgentConfiguration
    }
  | {
      readonly kind: 'pending'
      readonly revision: number
      readonly createdSessionId?: string
      readonly configuration: AgentConfiguration
    }

export interface SessionConfigurationController {
  readonly capturePresetSessionTarget: () => PresetSessionSyncTarget | undefined
  readonly synchronizeBlankSessionPreset: (target: PresetSessionSyncTarget, preset: string) => Promise<void>
  readonly nextConfigurationGeneration: () => number
  readonly isConfigurationGenerationCurrent: (generation: number) => boolean
  readonly nextPresetRosterGeneration: () => number
  readonly isPresetRosterCurrent: (generation: number) => boolean
}

/** Own the shared generation guards for explicit configuration and preset synchronization. */
export function createSessionConfigurationController({
  client,
  getState,
  setState,
  getPendingSendRevision,
}: {
  readonly client: Pick<ProtocolClient, 'request'>
  readonly getState: () => AppState
  readonly setState: StateSetter
  readonly getPendingSendRevision: () => number | undefined
}): SessionConfigurationController {
  let configurationGeneration = 0
  let presetRosterGeneration = 0
  const capturePresetSessionTarget = (): PresetSessionSyncTarget | undefined => {
    const state = getState()

    const pending = state.pendingSession
    if (pending !== undefined && getPendingSendRevision() !== pending.revision) {
      if (
        pending.createdSessionId === undefined ||
        state.sessions.some(
          (session) => session.id === pending.createdSessionId && session.blank && session.status === 'idle',
        )
      )
        return {
          kind: 'pending',
          revision: pending.revision,
          ...(pending.createdSessionId === undefined ? {} : { createdSessionId: pending.createdSessionId }),
          configuration: pending.configuration,
        }
    }
    const sessionId = state.activeSessionId
    const summary = state.sessions.find((session) => session.id === sessionId)
    if (
      sessionId !== undefined &&
      state.activeSubagent === undefined &&
      state.configuration !== undefined &&
      summary?.blank === true &&
      summary.status === 'idle'
    )
      return { kind: 'active', sessionId, configuration: state.configuration }
    return undefined
  }
  const presetSessionTargetIsCurrent = (target: PresetSessionSyncTarget): boolean => {
    const state = getState()

    if (target.kind === 'pending') {
      const pending = state.pendingSession
      return (
        pending?.revision === target.revision &&
        pending.createdSessionId === target.createdSessionId &&
        getPendingSendRevision() !== target.revision &&
        pending.configuration.preset === target.configuration.preset &&
        (target.createdSessionId === undefined ||
          state.sessions.some(
            (session) => session.id === target.createdSessionId && session.blank && session.status === 'idle',
          ))
      )
    }
    const summary = state.sessions.find((session) => session.id === target.sessionId)
    return (
      state.activeSessionId === target.sessionId &&
      state.activeSubagent === undefined &&
      state.configuration?.preset === target.configuration.preset &&
      summary?.blank === true &&
      summary.status === 'idle'
    )
  }
  const synchronizeBlankSessionPreset = async (
    target: PresetSessionSyncTarget,
    preset: string,
  ): Promise<void> => {
    if (target.configuration.preset === preset || !presetSessionTargetIsCurrent(target)) return
    const configuration = { ...target.configuration, preset }
    if (target.kind === 'pending' && target.createdSessionId === undefined) {
      setState((current) => {
        const pending = current.pendingSession
        if (
          pending?.revision !== target.revision ||
          pending.createdSessionId !== undefined ||
          pending.configuration.preset !== target.configuration.preset ||
          getPendingSendRevision() === target.revision
        )
          return current
        return { ...current, pendingSession: { ...pending, configuration } }
      })
      return
    }
    if (!presetSessionTargetIsCurrent(target)) return
    const sessionId = target.kind === 'active' ? target.sessionId : target.createdSessionId
    if (sessionId === undefined) return
    const generation = ++configurationGeneration
    await client.request<unknown>({
      type: 'session.configure',
      requestId: requestId(),
      payload: { sessionId, configuration },
    })
    if (generation !== configurationGeneration || !presetSessionTargetIsCurrent(target)) return
    if (target.kind === 'active')
      setState((current) => {
        const summary = current.sessions.find((session) => session.id === target.sessionId)
        if (
          current.activeSessionId !== target.sessionId ||
          current.activeSubagent !== undefined ||
          current.configuration?.preset !== target.configuration.preset ||
          summary?.blank !== true ||
          summary.status !== 'idle'
        )
          return current
        return { ...current, configuration }
      })
    else
      setState((current) => {
        const pending = current.pendingSession
        const summary = current.sessions.find((session) => session.id === target.createdSessionId)
        if (
          pending?.revision !== target.revision ||
          pending.createdSessionId !== target.createdSessionId ||
          pending.configuration.preset !== target.configuration.preset ||
          getPendingSendRevision() === target.revision ||
          summary?.blank !== true ||
          summary.status !== 'idle'
        )
          return current
        return { ...current, pendingSession: { ...pending, configuration } }
      })
  }
  return {
    capturePresetSessionTarget,
    synchronizeBlankSessionPreset,
    nextConfigurationGeneration: () => ++configurationGeneration,
    isConfigurationGenerationCurrent: (generation) => generation === configurationGeneration,
    nextPresetRosterGeneration: () => ++presetRosterGeneration,
    isPresetRosterCurrent: (generation) => generation === presetRosterGeneration,
  }
}
