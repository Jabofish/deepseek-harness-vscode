import { AppError, type AgentConfiguration, type AgentPresetDescriptor } from '@dsh-vscode/domain'

/** Optional transport fields are normalized before producing a Domain configuration. */
export interface SessionConfigurationInput extends Pick<
  AgentConfiguration,
  'preset' | 'toolMode' | 'permissionPreset' | 'planMode'
> {
  readonly permissionPresetKnown?: boolean | undefined
  readonly planModeKnown?: boolean | undefined
  readonly sandboxMode?: string | undefined
  readonly approvalPolicy?: string | undefined
  readonly model: Pick<AgentConfiguration['model'], 'providerId' | 'modelId'> & {
    readonly reasoningLevel?: string | undefined
  }
}

/** Preserve whether policy values are choices or unobserved display fallbacks. */
export function resolveSessionConfigurationForRoster(
  requested: SessionConfigurationInput,
  presets: readonly AgentPresetDescriptor[],
): AgentConfiguration {
  const usable = presets.filter((preset) => preset.broken === undefined)
  const requestedId = requested.preset.trim()
  const selected =
    requestedId === ''
      ? (usable.find((preset) => preset.isDefault) ?? usable[0])
      : usable.find((preset) => preset.id === requestedId)
  if ((requestedId !== '' && selected === undefined) || (presets.length > 0 && usable.length === 0))
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The selected agent preset is unavailable. Choose an available preset before sending.',
      retryable: false,
    })

  return {
    // An empty optional roster leaves composition to DSH. The adapter omits
    // this sentinel from the wire instead of inventing a preset identifier.
    preset: selected?.id ?? '',
    toolMode: requested.toolMode,
    permissionPreset: requested.permissionPreset,
    planMode: requested.planMode,
    ...(requested.permissionPresetKnown === undefined
      ? {}
      : { permissionPresetKnown: requested.permissionPresetKnown }),
    ...(requested.planModeKnown === undefined ? {} : { planModeKnown: requested.planModeKnown }),
    ...(requested.sandboxMode === undefined ? {} : { sandboxMode: requested.sandboxMode }),
    ...(requested.approvalPolicy === undefined ? {} : { approvalPolicy: requested.approvalPolicy }),
    model: {
      providerId: requested.model.providerId,
      modelId: requested.model.modelId,
      ...(requested.model.reasoningLevel === undefined
        ? {}
        : { reasoningLevel: requested.model.reasoningLevel }),
    },
  }
}
