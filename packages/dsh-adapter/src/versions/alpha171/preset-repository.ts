import type { AgentPresetDescriptor, AgentPresetRoster, PresetRepository } from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'

import type { DshTransport } from '../../contracts.js'
import { callRpc } from '../rc6/rpc.js'

/**
 * Alpha.1's registry is deployment-owned: it composes declarative preset
 * entries and exposes only list/select. It has no user-root trust, authoring,
 * document, copy, or delete Remote, so those optional domain methods remain
 * absent instead of being inherited from the removed alpha.2 API.
 */
export class Alpha171PresetRepository implements PresetRepository {
  public constructor(private readonly transport: DshTransport) {}

  public async list(signal?: AbortSignal): Promise<AgentPresetRoster> {
    const value = await callRpc<unknown>(this.transport, 'agentPreset.list', {}, signal)
    const record = requiredRecord(value)
    if (!Array.isArray(record.presets) || typeof record.modeSelectionEnabled !== 'boolean')
      throw malformedPresetResponse('roster')
    return {
      presets: record.presets.map(presetDescriptor),
      authorable: false,
      compositionReadable: false,
      defaultSettingPath: 'agent-preset-registry.selectedDefault',
      modeSelectionEnabled: record.modeSelectionEnabled,
    }
  }

  public async select(sessionId: string, presetId: string, signal?: AbortSignal): Promise<void> {
    const value = await callRpc<unknown>(
      this.transport,
      'agentPreset.select',
      { sessionId, agentPreset: presetId },
      signal,
    )
    const record = requiredRecord(value)
    if (typeof record.agentPreset !== 'string' || record.agentPreset !== presetId)
      throw malformedPresetResponse('selection')
  }
}

function presetDescriptor(value: unknown): AgentPresetDescriptor {
  const record = requiredRecord(value)
  if (
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    typeof record.isDefault !== 'boolean' ||
    (record.name !== undefined && typeof record.name !== 'string') ||
    (record.description !== undefined && typeof record.description !== 'string') ||
    (record.broken !== undefined && (typeof record.broken !== 'string' || record.broken.length === 0))
  )
    throw malformedPresetResponse('roster entry')
  // Alpha171 has no user-root/trust field: every registry definition is
  // deployment-owned, so the local management projection stays system-owned
  // and authorable=false prevents any fabricated user write path.
  return {
    id: record.id,
    trust: 'system',
    isDefault: record.isDefault,
    ...(record.name === undefined ? {} : { name: record.name }),
    ...(record.description === undefined ? {} : { description: record.description }),
    ...(record.broken === undefined ? {} : { broken: record.broken }),
  }
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value))
    return value as Record<string, unknown>
  throw malformedPresetResponse('response')
}

function malformedPresetResponse(part: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed alpha171 preset ${part}.`,
    retryable: false,
  })
}
