import type {
  AgentConfiguration,
  AgentPresetDescriptor,
  AgentPresetRoster,
  DynamicCommand,
  PromptMode,
} from '@dsh-vscode/domain'
import { object } from './unknown-record.js'

export function applyKnownCommand(configuration: AgentConfiguration, command: string): AgentConfiguration {
  const parts = command.trim().replace(/^\//u, '').split(/\s+/u)
  if (parts[0] === 'permission' && parts[1] !== undefined)
    return { ...configuration, permissionPreset: parts[1], permissionPresetKnown: true }
  if (parts[0] === 'plan') return { ...configuration, planMode: parts[1] !== 'off', planModeKnown: true }
  return configuration
}

export function hasDynamicCommand(commands: readonly DynamicCommand[], name: string): boolean {
  const target = name.trim().toLocaleLowerCase()
  return commands.some((command) => command.name.trim().toLocaleLowerCase() === target)
}

export function promptModeAfterCommand(current: PromptMode, command: string): PromptMode | undefined {
  const parts = command.trim().replace(/^\//u, '').split(/\s+/u)
  if (parts[0]?.toLocaleLowerCase() !== 'plan') return undefined
  return parts[1]?.toLocaleLowerCase() === 'off' ? (current === 'plan' ? 'ask' : current) : 'plan'
}

export function promptModeForConfiguration(preferred: PromptMode, planMode: boolean): PromptMode {
  if (planMode) return 'plan'
  return preferred === 'plan' ? 'ask' : preferred
}

export function isPresetDescriptor(value: unknown): value is AgentPresetDescriptor {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    (item.trust === 'system' || item.trust === 'user') &&
    typeof item.isDefault === 'boolean' &&
    (item.name === undefined || typeof item.name === 'string') &&
    (item.description === undefined || typeof item.description === 'string') &&
    (item.broken === undefined || typeof item.broken === 'string')
  )
}

/** Parse the `agentPreset.list` answer: roster rows plus the deployment facts. */
export function parsePresetRoster(value: unknown): AgentPresetRoster | undefined {
  const roster = object(value)
  if (
    roster === undefined ||
    !Array.isArray(roster.presets) ||
    !roster.presets.every(isPresetDescriptor) ||
    typeof roster.authorable !== 'boolean' ||
    // Absent means the host did not state its native-opener capability; a
    // stated value must still be a boolean.
    (roster.hasDocument !== undefined && typeof roster.hasDocument !== 'boolean') ||
    (roster.canOpenPresetLocation !== undefined && typeof roster.canOpenPresetLocation !== 'boolean') ||
    (roster.canRemoveUserPresets !== undefined && typeof roster.canRemoveUserPresets !== 'boolean') ||
    (roster.modeSelectionEnabled !== undefined && typeof roster.modeSelectionEnabled !== 'boolean') ||
    (roster.compositionReadable !== undefined && typeof roster.compositionReadable !== 'boolean') ||
    (roster.defaultSettingPath !== undefined && typeof roster.defaultSettingPath !== 'string')
  )
    return undefined
  return {
    presets: roster.presets,
    ...(typeof roster.compositionReadable === 'boolean'
      ? { compositionReadable: roster.compositionReadable }
      : {}),
    ...(typeof roster.defaultSettingPath === 'string'
      ? { defaultSettingPath: roster.defaultSettingPath }
      : {}),
    authorable: roster.authorable,
    ...(typeof roster.hasDocument === 'boolean' ? { hasDocument: roster.hasDocument } : {}),
    ...(typeof roster.canOpenPresetLocation === 'boolean'
      ? { canOpenPresetLocation: roster.canOpenPresetLocation }
      : {}),
    ...(typeof roster.canRemoveUserPresets === 'boolean'
      ? { canRemoveUserPresets: roster.canRemoveUserPresets }
      : {}),
    ...(typeof roster.modeSelectionEnabled === 'boolean'
      ? { modeSelectionEnabled: roster.modeSelectionEnabled }
      : {}),
  }
}
