import { AppError, type AgentConfiguration, type SessionDetail } from '@dsh-vscode/domain'
import type { DshTransport } from '../../contracts.js'
import { callRpc, unavailable } from '../../versions/rc6/rpc.js'
import { executeSessionConfigCommand, type CommandAttachmentWire } from '../command-repository.js'
import { assertModelSelection, malformedSessionResponse, requiredRecord } from './responses.js'
import { isPermissionPresetId } from './queue-helpers.js'

export interface SessionConfigurationDependencies {
  readonly transport: DshTransport
  readonly commandAttachmentWire: CommandAttachmentWire
  readonly readPermissionPresets: ((signal?: AbortSignal) => Promise<readonly string[]>) | undefined
  readonly selectAgentPreset:
    ((sessionId: string, presetId: string, signal?: AbortSignal) => Promise<void>) | undefined
  readonly executeSessionConfigurationCommand:
    ((sessionId: string, command: string, signal?: AbortSignal) => Promise<void>) | undefined
  readonly get: (sessionId: string, signal?: AbortSignal) => Promise<SessionDetail>
}
export async function setSessionConfiguration(
  deps: SessionConfigurationDependencies,
  sessionId: string,
  configuration: AgentConfiguration,
  signal?: AbortSignal,
): Promise<void> {
  if (configuration.toolMode !== 'native') throw unavailable('per-session tool mode')
  const hasProvider = configuration.model.providerId.trim() !== ''
  const hasModel = configuration.model.modelId.trim() !== ''
  if (hasProvider !== hasModel)
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The session model selection is incomplete.',
      retryable: false,
    })
  const requestedPermission = configuration.permissionPreset.trim()
  if (!isPermissionPresetId(requestedPermission))
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The session permission preset is invalid.',
      retryable: false,
    })
  const current = await deps.get(sessionId, signal)
  const currentPermissionValue = current.configuration.permissionPreset.trim()
  const currentPermission =
    current.configuration.permissionPresetKnown === false ? undefined : currentPermissionValue
  // `configuration.permissionPreset` is a display fallback when the host has
  // no observed current value. If a full configuration update carries that
  // unchanged fallback, do not turn an unrelated model/preset edit into a
  // permission command that writes an unobserved value back to DSH.
  const permissionBaseline =
    current.configuration.permissionPresetKnown === false && deps.readPermissionPresets !== undefined
      ? currentPermissionValue
      : currentPermission
  const permissionChanged = requestedPermission !== permissionBaseline
  if (
    permissionChanged &&
    deps.readPermissionPresets !== undefined &&
    current.permissionPresets === undefined
  )
    throw unavailable('changing a permission preset without an authoritative DSH catalog')
  if (
    permissionChanged &&
    current.permissionPresets !== undefined &&
    !current.permissionPresets.includes(requestedPermission)
  )
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The requested session permission preset is not advertised by DSH.',
      retryable: false,
    })

  const requestedPreset = configuration.preset.trim()
  const currentPreset = current.configuration.preset.trim()
  const presetSelectionUnavailable =
    current.status !== 'idle' || (deps.selectAgentPreset !== undefined && !current.blank)
  if (requestedPreset !== '' && requestedPreset !== currentPreset && presetSelectionUnavailable)
    throw unavailable('changing the agent preset of an existing session')

  const selectModel = async (
    model: {
      readonly providerId: string
      readonly modelId: string
      readonly reasoningLevel?: string
    },
    operationSignal?: AbortSignal,
  ): Promise<void> => {
    assertModelSelection(
      await callRpc<unknown>(
        deps.transport,
        'session.selectModel',
        {
          sessionId,
          provider: model.providerId,
          model: model.modelId,
          ...(model.reasoningLevel === undefined ? {} : { reasoningEffort: model.reasoningLevel }),
        },
        operationSignal,
      ),
    )
  }
  const previousModel = current.configuration.model
  const modelChanged =
    hasModel &&
    (previousModel.providerId !== configuration.model.providerId ||
      previousModel.modelId !== configuration.model.modelId ||
      previousModel.reasoningLevel !== configuration.model.reasoningLevel)
  const rollback: Array<() => Promise<void>> = []
  const apply = async (forward: () => Promise<void>, reverse: () => Promise<void>): Promise<void> => {
    await forward()
    rollback.unshift(reverse)
  }
  const selectPreset = async (preset: string, operationSignal?: AbortSignal): Promise<void> => {
    if (deps.selectAgentPreset !== undefined) {
      await deps.selectAgentPreset(sessionId, preset, operationSignal)
      return
    }
    const value = await callRpc<unknown>(
      deps.transport,
      'agentPreset.select',
      { sessionId, agentPreset: preset },
      operationSignal,
    )
    const presetRecord = requiredRecord(value, 'agent preset selection')
    if (typeof presetRecord.agentPreset !== 'string' || presetRecord.agentPreset.trim() === '')
      throw malformedSessionResponse('agent preset selection')
  }
  const command = async (value: string, operationSignal?: AbortSignal): Promise<void> => {
    if (deps.executeSessionConfigurationCommand !== undefined) {
      await deps.executeSessionConfigurationCommand(sessionId, value, operationSignal)
      return
    }
    await executeSessionConfigCommand(
      deps.transport,
      sessionId,
      value,
      deps.commandAttachmentWire,
      operationSignal,
    )
  }

  try {
    // DSH exposes independent mutation RPCs rather than a transaction. Apply
    // the cheap host-validated settings first and keep explicit compensating
    // actions so a later failure does not leave a mixed configuration.
    if (requestedPreset !== '' && requestedPreset !== currentPreset)
      await apply(
        () => selectPreset(requestedPreset, signal),
        () => (currentPreset === '' ? Promise.resolve() : selectPreset(currentPreset)),
      )
    if (permissionChanged)
      await apply(
        () => command(`/permission ${requestedPermission}`, signal),
        () =>
          currentPermission !== undefined && isPermissionPresetId(currentPermission)
            ? command(`/permission ${currentPermission}`)
            : Promise.reject(unavailable('restoring an unknown permission setting')),
      )
    if (
      current.configuration.planModeKnown === false ||
      configuration.planMode !== current.configuration.planMode
    )
      await apply(
        () => command(configuration.planMode ? '/plan' : '/plan off', signal),
        () =>
          current.configuration.planModeKnown === false
            ? Promise.reject(unavailable('restoring an unknown plan setting'))
            : command(current.configuration.planMode ? '/plan' : '/plan off'),
      )
    if (modelChanged)
      await apply(
        () => selectModel(configuration.model, signal),
        () =>
          previousModel.providerId.trim() !== '' && previousModel.modelId.trim() !== ''
            ? selectModel(previousModel)
            : Promise.resolve(),
      )
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const undo of rollback) {
      try {
        await undo()
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length > 0)
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'DSH configuration failed and could not be fully restored.',
        retryable: true,
        cause: new AggregateError([error, ...rollbackErrors]),
      })
    throw error
  }
}
