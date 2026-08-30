import {
  AppError,
  type AgentPresetPluginGroup,
  type AgentPresetPluginRow,
  type PluginFiberPhase,
  type PluginInventorySnapshot,
  type PresetPluginEnablement,
  type PluginRepository,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { unwrapRpcResultValue } from '../versions/rc6/rpc.js'

const FIBER_PHASES: readonly string[] = ['pending', 'loading', 'active', 'failed', 'unloading']

function isFiberPhase(value: unknown): value is Exclude<PluginFiberPhase, null> {
  return typeof value === 'string' && FIBER_PHASES.includes(value)
}

/**
 * Reads the host's assembled loader tree through the pinned rc.6
 * `pluginInventory/list` direct Remote. The projection is read-only: the
 * contract publishes no cache, event stream, or mutation path, so neither
 * does this repository.
 */
export class Rc6PluginRepository implements PluginRepository {
  public constructor(private readonly transport: DshTransport) {}

  public async inventory(signal?: AbortSignal): Promise<PluginInventorySnapshot> {
    const result = await this.transport.remoteRequest<unknown>('pluginInventory/list', {}, signal)
    const value = unwrapRpcResultValue<{ entries?: unknown; agentPresets?: unknown }>(
      result,
      'pluginInventory/list',
    )
    if (typeof value !== 'object' || value === null || !Array.isArray(value.entries))
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
      ...(agentPresets === undefined ? {} : { agentPresets }),
    }
  }
}

function toInventoryEntry(value: unknown): PluginInventorySnapshot['entries'][number] {
  if (typeof value !== 'object' || value === null) throw malformedInventory()
  const record = value as Record<string, unknown>
  const { entryId, moduleName, enabled, fiberPhase } = record
  if (
    typeof entryId !== 'string' ||
    entryId.length === 0 ||
    typeof moduleName !== 'string' ||
    moduleName.trim() === '' ||
    typeof enabled !== 'boolean' ||
    !(fiberPhase === null || isFiberPhase(fiberPhase))
  )
    throw malformedInventory()
  // `null` is the contract's "no live root fiber" phase — keep it verbatim.
  return { entryId, moduleName, enabled, fiberPhase }
}

function toAgentPresetPluginGroup(value: unknown): AgentPresetPluginGroup {
  if (typeof value !== 'object' || value === null) throw malformedInventory()
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    (record.trust !== 'system' && record.trust !== 'user') ||
    typeof record.isDefault !== 'boolean' ||
    !Array.isArray(record.rows) ||
    (record.name !== undefined && typeof record.name !== 'string') ||
    (record.broken !== undefined && typeof record.broken !== 'string')
  )
    throw malformedInventory()
  return {
    id: record.id,
    trust: record.trust,
    isDefault: record.isDefault,
    ...(record.name === undefined ? {} : { name: record.name }),
    ...(record.broken === undefined ? {} : { broken: record.broken }),
    rows: record.rows.map(toAgentPresetPluginRow),
  }
}

function toAgentPresetPluginRow(value: unknown): AgentPresetPluginRow {
  if (typeof value !== 'object' || value === null) throw malformedInventory()
  const record = value as Record<string, unknown>
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
    enabled: record.enabled,
    ...(record.condition === undefined ? {} : { condition: record.condition }),
    fiberPhase: record.fiberPhase,
  }
}

function isPresetPluginEnablement(value: unknown): value is PresetPluginEnablement {
  return typeof value === 'boolean' || value === 'conditional'
}

function malformedInventory(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed plugin inventory.',
    retryable: false,
  })
}
