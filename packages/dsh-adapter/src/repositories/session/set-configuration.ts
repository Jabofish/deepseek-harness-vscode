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
// One transport belongs to one backend connection. Independent sessions and
// replacement backends must not share a transaction lock.
const configurationTails = new WeakMap<DshTransport, Map<string, Promise<void>>>()

export function setSessionConfiguration(
  deps: SessionConfigurationDependencies,
  sessionId: string,
  configuration: AgentConfiguration,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(cancelledConfiguration())
  const tails = configurationTails.get(deps.transport) ?? new Map<string, Promise<void>>()
  configurationTails.set(deps.transport, tails)
  const preceding = tails.get(sessionId) ?? Promise.resolve()
  let started = false
  const operation = preceding.then(async () => {
    started = true
    if (signal?.aborted === true) throw cancelledConfiguration()
    await applySessionConfiguration(deps, sessionId, configuration, signal)
  })
  const tail = operation.then(
    () => undefined,
    () => undefined,
  )
  tails.set(sessionId, tail)
  void tail.then(() => {
    if (tails.get(sessionId) === tail) tails.delete(sessionId)
    if (tails.size === 0 && configurationTails.get(deps.transport) === tails)
      configurationTails.delete(deps.transport)
  })
  // A queued caller can cancel immediately. Active transactions finish their
  // compensation before reporting an outcome, including restoration failures.
  return rejectConfigurationWhileQueued(operation, signal, () => started)
}

function cancelledConfiguration(): AppError {
  return new AppError({
    code: 'REQUEST_CANCELLED',
    message: 'The session configuration operation was cancelled.',
    retryable: false,
  })
}

function rejectConfigurationWhileQueued(
  operation: Promise<void>,
  signal: AbortSignal | undefined,
  started: () => boolean,
): Promise<void> {
  if (signal === undefined) return operation
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      cleanup()
      if (!started()) reject(cancelledConfiguration())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      () => {
        cleanup()
        resolve()
      },
      (error: unknown) => {
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

async function applySessionConfiguration(
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
  if (signal?.aborted === true) throw cancelledConfiguration()
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
  const permissionChanged =
    configuration.permissionPresetKnown !== false &&
    (requestedPermission !== permissionBaseline ||
      (configuration.permissionPresetKnown === true && currentPermission === undefined))
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
  const anotherSettingChanged =
    modelChanged ||
    requestedPermission !== currentPermissionValue ||
    (requestedPreset !== '' && requestedPreset !== currentPreset)
  const rollback: Array<() => Promise<void>> = []
  const apply = async (
    forward: () => Promise<void>,
    reverse: () => Promise<void>,
    observe: (detail: SessionDetail) => boolean | undefined,
  ): Promise<void> => {
    if (signal?.aborted === true) throw cancelledConfiguration()
    try {
      await forward()
    } catch (error) {
      // A transport failure can lose the receipt of an already committed
      // mutation. Never resend it: read the authoritative state without the
      // cancelled signal, and compensate only an observed requested value.
      if (
        !(error instanceof AppError) ||
        ['REQUEST_CANCELLED', 'BACKEND_UNREACHABLE', 'PROTOCOL_ERROR', 'INTERNAL_ERROR'].includes(error.code)
      ) {
        try {
          const applied = observe(await deps.get(sessionId))
          if (applied === undefined) throw unavailable('confirming the failed configuration mutation')
          if (applied) rollback.unshift(reverse)
        } catch (observationError) {
          const failure =
            observationError instanceof Error
              ? observationError
              : new Error('The DSH configuration state could not be confirmed.')
          rollback.unshift(() => Promise.reject(failure))
        }
      }
      throw error
    }
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
        (detail) => observedChange(currentPreset, detail.configuration.preset, requestedPreset),
      )
    if (permissionChanged)
      await apply(
        () => command(`/permission ${requestedPermission}`, signal),
        () =>
          currentPermission !== undefined && isPermissionPresetId(currentPermission)
            ? command(`/permission ${currentPermission}`)
            : Promise.reject(unavailable('restoring an unknown permission setting')),
        (detail) =>
          detail.configuration.permissionPresetKnown === false || currentPermission === undefined
            ? undefined
            : observedChange(currentPermission, detail.configuration.permissionPreset, requestedPermission),
      )
    // A full snapshot carries the unobserved plan display fallback during
    // unrelated edits. Preserve explicit default/off writes when plan is the only edit.
    if (
      configuration.planModeKnown !== false &&
      (configuration.planMode !== current.configuration.planMode ||
        (current.configuration.planModeKnown === false &&
          (configuration.planModeKnown === true || !anotherSettingChanged)))
    )
      await apply(
        () => command(configuration.planMode ? '/plan' : '/plan off', signal),
        () =>
          current.configuration.planModeKnown === false
            ? Promise.reject(unavailable('restoring an unknown plan setting'))
            : command(current.configuration.planMode ? '/plan' : '/plan off'),
        (detail) =>
          current.configuration.planModeKnown === false || detail.configuration.planModeKnown === false
            ? undefined
            : observedChange(
                current.configuration.planMode,
                detail.configuration.planMode,
                configuration.planMode,
              ),
      )
    if (modelChanged)
      await apply(
        () => selectModel(configuration.model, signal),
        () =>
          previousModel.providerId.trim() !== '' && previousModel.modelId.trim() !== ''
            ? selectModel(previousModel)
            : Promise.reject(unavailable('restoring an unknown model selection')),
        (detail) =>
          sameModelSelection(detail.configuration.model, configuration.model)
            ? true
            : sameModelSelection(detail.configuration.model, previousModel)
              ? false
              : undefined,
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

function observedChange<T extends string | boolean>(
  before: T,
  observed: T,
  requested: T,
): boolean | undefined {
  return observed === requested ? true : observed === before ? false : undefined
}

function sameModelSelection(left: AgentConfiguration['model'], right: AgentConfiguration['model']): boolean {
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.reasoningLevel === right.reasoningLevel
  )
}
