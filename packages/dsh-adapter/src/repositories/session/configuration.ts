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
  let model = projectedModelSelection(undefined)
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
    const selection =
      event.type === 'request/header'
        ? asRecord(asRecord(data.header).config)
        : event.type === 'model/selection' || event.type === 'request/context'
          ? data
          : undefined
    if (selection === undefined) continue
    const providerId = firstString(selection.provider, selection.providerId)
    const modelId = firstString(selection.model, selection.modelId)
    const reasoningLevel = firstString(selection.reasoningEffort, selection.reasoningLevel)
    // Selection and header facts replace a complete route, including omitted
    // effort. Request context supplies route metadata, not replacement intent.
    model = {
      providerId: providerId ?? model.providerId,
      modelId: modelId ?? model.modelId,
      reasoningLevel:
        event.type !== 'request/context' && providerId !== undefined && modelId !== undefined
          ? reasoningLevel
          : (reasoningLevel ?? model.reasoningLevel),
    }
  }
  // The host keeps pending intent even when a later request used another
  // route. Its exact projection, including an empty selection, wins over logs.
  if (
    projectionValues !== undefined &&
    Object.prototype.hasOwnProperty.call(projectionValues, 'modelSelection')
  )
    model = projectedModelSelection(projectionValues)
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
