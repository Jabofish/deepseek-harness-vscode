import {
  AppError,
  isPluginMetadata,
  type PluginMetadata,
  type AgentPresetPluginGroup,
  type AgentPresetPluginRow,
  type PluginFiberPhase,
  type PluginInventorySnapshot,
  type PresetPluginEnablement,
  type PluginRepository,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../../contracts.js'
import { unwrapRpcResultValue } from '../rc6/rpc.js'

const FIBER_PHASES: readonly string[] = ['pending', 'loading', 'active', 'failed', 'unloading']

/**
 * Alpha.1's Host inventory omits ownership classification and adds optional
 * package metadata/management facts. Keep the composition projection limited
 * to the fields its Remote actually publishes.
 */
export class Alpha171PluginRepository implements PluginRepository {
  public constructor(private readonly transport: DshTransport) {}

  public async inventory(signal?: AbortSignal): Promise<PluginInventorySnapshot> {
    const result = await this.transport.remoteRequest<unknown>('pluginInventory/list', {}, signal)
    const value = unwrapRpcResultValue<Record<string, unknown>>(result, 'pluginInventory/list')
    if (
      value === null ||
      Array.isArray(value) ||
      !Array.isArray(value.entries) ||
      (value.managementAvailable !== undefined && typeof value.managementAvailable !== 'boolean')
    )
      throw malformedInventory()
    const agentPresets =
      value.agentPresets === undefined
        ? undefined
        : Array.isArray(value.agentPresets)
          ? value.agentPresets.map(toAgentPresetPluginGroup)
          : (() => {
              throw malformedInventory()
            })()
    return {
      entries: value.entries.map(toInventoryEntry),
      ...(typeof value.managementAvailable === 'boolean'
        ? { managementAvailable: value.managementAvailable }
        : {}),
      ...(agentPresets === undefined ? {} : { agentPresets }),
    }
  }
}

function toInventoryEntry(value: unknown): PluginInventorySnapshot['entries'][number] {
  const record = requiredRecord(value)
  if (
    typeof record.entryId !== 'string' ||
    record.entryId.length === 0 ||
    typeof record.moduleName !== 'string' ||
    record.moduleName.trim() === '' ||
    typeof record.enabled !== 'boolean' ||
    !(record.fiberPhase === null || isFiberPhase(record.fiberPhase))
  )
    throw malformedInventory()
  return {
    entryId: record.entryId,
    moduleName: record.moduleName,
    ...(record.meta === undefined ? {} : { meta: metadata(record.meta) }),
    enabled: record.enabled,
    fiberPhase: record.fiberPhase,
  }
}

function toAgentPresetPluginGroup(value: unknown): AgentPresetPluginGroup {
  const record = requiredRecord(value)
  if (
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    typeof record.isDefault !== 'boolean' ||
    !Array.isArray(record.rows) ||
    (record.name !== undefined && typeof record.name !== 'string') ||
    (record.broken !== undefined && typeof record.broken !== 'string')
  )
    throw malformedInventory()
  return {
    id: record.id,
    isDefault: record.isDefault,
    ...(record.name === undefined ? {} : { name: record.name }),
    ...(record.broken === undefined ? {} : { broken: record.broken }),
    rows: record.rows.map(toAgentPresetPluginRow),
  }
}

function toAgentPresetPluginRow(value: unknown): AgentPresetPluginRow {
  const record = requiredRecord(value)
  if (
    !(record.entryId === null || (typeof record.entryId === 'string' && record.entryId.length > 0)) ||
    typeof record.moduleName !== 'string' ||
    record.moduleName.trim() === '' ||
    !isPresetPluginEnablement(record.enabled) ||
    !(record.fiberPhase === null || isFiberPhase(record.fiberPhase)) ||
    (record.condition !== undefined && typeof record.condition !== 'string')
  )
    throw malformedInventory()
  return {
    entryId: record.entryId,
    moduleName: record.moduleName,
    ...(record.meta === undefined ? {} : { meta: metadata(record.meta) }),
    enabled: record.enabled,
    ...(record.condition === undefined ? {} : { condition: record.condition }),
    fiberPhase: record.fiberPhase,
  }
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw malformedInventory()
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw malformedInventory()
  return value as Record<string, unknown>
}

function isFiberPhase(value: unknown): value is Exclude<PluginFiberPhase, null> {
  return typeof value === 'string' && FIBER_PHASES.includes(value)
}

function isPresetPluginEnablement(value: unknown): value is PresetPluginEnablement {
  return typeof value === 'boolean' || value === 'conditional'
}

function malformedInventory(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed alpha171 plugin inventory.',
    retryable: false,
  })
}

function metadata(value: unknown): PluginMetadata {
  if (!isPluginMetadata(value)) throw malformedInventory()
  return {
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.icon === undefined ? {} : { icon: value.icon }),
    ...(value.error === undefined ? {} : { error: value.error }),
  }
}
