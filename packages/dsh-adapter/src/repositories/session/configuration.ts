import type { AgentConfiguration } from '@dsh-vscode/domain'
import { projectedModelSelection } from '../../projection/agent.js'

export function defaultConfiguration(): AgentConfiguration {
  return {
    preset: 'standard',
    toolMode: 'native',
    permissionPreset: 'workspace-write',
    planMode: false,
    model: { providerId: '', modelId: '' },
  }
}

export function configurationFromRawHistory(
  history: readonly unknown[],
  agentPreset?: string,
  projectionValues?: Readonly<Record<string, unknown>>,
): AgentConfiguration {
  let model = projectedModelSelection(projectionValues)
  let permissionPreset = 'workspace-write'
  let permissionPresetKnown = false
  let planModeKnown = false
  let planMode = false
  let sandboxMode: string | undefined
  let approvalPolicy: string | undefined
  for (const entry of history) {
    const historyEntry = asRecord(entry)
    const event = asRecord(historyEntry.event ?? historyEntry)
    const data = asRecord(event.data)
    if (event.type === 'permission/preset') {
      const preset = firstString(data.preset, data.value, data.name, asRecord(data.permission).preset)
      if (preset !== undefined) {
        permissionPreset = preset
        permissionPresetKnown = true
      }
      continue
    }
    if (event.type === 'plan/mode') {
      const active = booleanValue(data.active ?? data.enabled ?? data.on ?? data.value)
      if (active !== undefined) {
        planMode = active
        planModeKnown = true
      } else if (data.mode === 'plan' || data.mode === 'on' || data.mode === 'active') {
        planMode = true
        planModeKnown = true
      } else if (data.mode === 'off' || data.mode === 'normal' || data.mode === 'inactive') {
        planMode = false
        planModeKnown = true
      }
      continue
    }
    if (event.type === 'sandbox/mode') {
      const mode = firstString(data.mode, data.value, data.name)
      if (mode !== undefined) sandboxMode = mode
      continue
    }
    if (event.type === 'approval/policy') {
      const policy = firstString(data.policy, data.value, data.name)
      if (policy !== undefined) approvalPolicy = policy
      continue
    }
    if (event.type === 'model/selection') {
      const provider = firstString(data.provider, data.providerId)
      const modelId = firstString(data.model, data.modelId)
      const reasoningLevel = firstString(data.reasoningEffort, data.reasoningLevel)
      model = {
        providerId: provider ?? model.providerId,
        modelId: modelId ?? model.modelId,
        reasoningLevel: reasoningLevel ?? model.reasoningLevel,
      }
      continue
    }
    if (event.type === 'request/context') {
      const provider = firstString(data.provider, data.providerId)
      const modelId = firstString(data.model, data.modelId)
      const reasoningLevel = firstString(data.reasoningEffort, data.reasoningLevel)
      model = {
        providerId: provider ?? model.providerId,
        modelId: modelId ?? model.modelId,
        reasoningLevel: reasoningLevel ?? model.reasoningLevel,
      }
      continue
    }
    if (event.type !== 'request/header') continue
    const header = asRecord(data.header)
    const config = asRecord(header.config)
    const providerId = typeof config.provider === 'string' ? config.provider : model.providerId
    const modelId = typeof config.model === 'string' ? config.model : model.modelId
    const reasoningLevel =
      typeof config.reasoningEffort === 'string' ? config.reasoningEffort : model.reasoningLevel
    model = { providerId, modelId, reasoningLevel }
  }
  const projectedPermission = firstString(asRecord(projectionValues?.permissions).currentValue)
  const projectedPlan = asRecord(projectionValues?.plan).active
  if (projectedPermission !== undefined) {
    permissionPreset = projectedPermission
    permissionPresetKnown = true
  }
  if (typeof projectedPlan === 'boolean') {
    planMode = projectedPlan
    planModeKnown = true
  }
  return {
    ...defaultConfiguration(),
    permissionPresetKnown,
    planModeKnown,
    ...(agentPreset === undefined ? {} : { preset: agentPreset }),
    permissionPreset: firstString(asRecord(projectionValues?.permissions).currentValue) ?? permissionPreset,
    planMode,
    ...(sandboxMode === undefined ? {} : { sandboxMode }),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
    model: {
      providerId: model.providerId,
      modelId: model.modelId,
      ...(model.reasoningLevel === undefined ? {} : { reasoningLevel: model.reasoningLevel }),
    },
  }
}

export function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim() !== '')
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
