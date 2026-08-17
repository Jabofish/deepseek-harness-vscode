import {
  AppError,
  type PluginFiberPhase,
  type PluginInventorySnapshot,
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
    const value = unwrapRpcResultValue<{ entries?: unknown }>(result, 'pluginInventory/list')
    if (typeof value !== 'object' || value === null || !Array.isArray(value.entries))
      throw malformedInventory()
    return { entries: value.entries.map(toInventoryEntry) }
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

function malformedInventory(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed plugin inventory.',
    retryable: false,
  })
}
