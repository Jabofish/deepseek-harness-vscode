import { isPluginMetadata, type PluginInventorySnapshot } from '@dsh-vscode/domain'
import { object } from './unknown-record.js'

export const FIBER_PHASES: readonly string[] = ['pending', 'loading', 'active', 'failed', 'unloading']

export function isPluginInventoryEntry(value: unknown): value is PluginInventorySnapshot['entries'][number] {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.entryId === 'string' &&
    item.entryId.length > 0 &&
    typeof item.moduleName === 'string' &&
    (item.meta === undefined || isPluginMetadata(item.meta)) &&
    typeof item.enabled === 'boolean' &&
    (item.fiberPhase === null ||
      (typeof item.fiberPhase === 'string' && FIBER_PHASES.includes(item.fiberPhase)))
  )
}

export type AgentPresetPluginGroup = NonNullable<PluginInventorySnapshot['agentPresets']>[number]
export type AgentPresetPluginRow = AgentPresetPluginGroup['rows'][number]

export function isAgentPresetPluginGroup(value: unknown): value is AgentPresetPluginGroup {
  const group = object(value)
  return (
    group !== undefined &&
    typeof group.id === 'string' &&
    group.id.length > 0 &&
    (group.trust === undefined || group.trust === 'system' || group.trust === 'user') &&
    typeof group.isDefault === 'boolean' &&
    Array.isArray(group.rows) &&
    (group.name === undefined || typeof group.name === 'string') &&
    (group.broken === undefined || typeof group.broken === 'string') &&
    group.rows.every(isAgentPresetPluginRow)
  )
}

export function isAgentPresetPluginRow(value: unknown): value is AgentPresetPluginRow {
  const row = object(value)
  return (
    row !== undefined &&
    (row.entryId === null || (typeof row.entryId === 'string' && row.entryId.length > 0)) &&
    typeof row.moduleName === 'string' &&
    (row.meta === undefined || isPluginMetadata(row.meta)) &&
    row.moduleName.trim() !== '' &&
    (typeof row.enabled === 'boolean' || row.enabled === 'conditional') &&
    (row.condition === undefined || typeof row.condition === 'string') &&
    (row.fiberPhase === null || (typeof row.fiberPhase === 'string' && FIBER_PHASES.includes(row.fiberPhase)))
  )
}

/** Parse the `pluginInventory/list` projection as one complete snapshot. */
export function parsePluginInventory(value: unknown): PluginInventorySnapshot | undefined {
  const snapshot = object(value)
  if (
    snapshot === undefined ||
    !Array.isArray(snapshot.entries) ||
    (snapshot.managementAvailable !== undefined && typeof snapshot.managementAvailable !== 'boolean')
  )
    return undefined
  const entries: PluginInventorySnapshot['entries'][number][] = []
  for (const entry of snapshot.entries) {
    if (!isPluginInventoryEntry(entry)) return undefined
    entries.push(entry)
  }
  const agentPresets = snapshot.agentPresets
  let parsedAgentPresets: AgentPresetPluginGroup[] | undefined
  if (agentPresets !== undefined) {
    if (!Array.isArray(agentPresets)) return undefined
    parsedAgentPresets = []
    for (const group of agentPresets) {
      if (!isAgentPresetPluginGroup(group)) return undefined
      parsedAgentPresets.push(group)
    }
  }
  return {
    entries,
    ...(parsedAgentPresets === undefined ? {} : { agentPresets: parsedAgentPresets }),
    ...(typeof snapshot.managementAvailable === 'boolean'
      ? { managementAvailable: snapshot.managementAvailable }
      : {}),
  }
}
