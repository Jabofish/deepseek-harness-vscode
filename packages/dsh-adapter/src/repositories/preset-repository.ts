import type {
  AgentPresetDescriptor,
  AgentPresetDocument,
  AgentPresetLocation,
  AgentPresetRoster,
  PresetRepository,
} from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc } from '../versions/rc6/rpc.js'

export class Rc6PresetRepository implements PresetRepository {
  public constructor(private readonly transport: DshTransport) {}

  public async list(signal?: AbortSignal): Promise<AgentPresetRoster> {
    const value = await callRpc<unknown>(this.transport, 'agentPreset.list', {}, signal)
    const record = requiredRecord(value)
    if (
      !Array.isArray(record.presets) ||
      typeof record.authorable !== 'boolean' ||
      typeof record.hasDocument !== 'boolean'
    )
      throw malformedPresetResponse('roster')
    return {
      presets: record.presets.map(presetDescriptor),
      authorable: record.authorable,
      hasDocument: record.hasDocument,
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
    if (typeof record.agentPreset !== 'string' || record.agentPreset.trim() === '')
      throw malformedPresetResponse('selection')
  }

  public async read(presetId: string, signal?: AbortSignal): Promise<AgentPresetDocument> {
    const value = await callRpc<Record<string, unknown>>(
      this.transport,
      'agentPreset.read',
      { agentPreset: presetId },
      signal,
    )
    const record = requiredRecord(value)
    if (
      typeof record.agentPreset !== 'string' ||
      record.agentPreset.trim() === '' ||
      (record.trust !== 'system' && record.trust !== 'user') ||
      typeof record.content !== 'string'
    )
      throw malformedPresetResponse('document')
    if (
      (record.name !== undefined && typeof record.name !== 'string') ||
      (record.description !== undefined && typeof record.description !== 'string')
    )
      throw malformedPresetResponse('document')
    return {
      id: record.agentPreset,
      trust: record.trust,
      content: record.content,
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
    }
  }

  public async copy(from: string, presetId: string, name?: string, signal?: AbortSignal): Promise<string> {
    const value = requiredRecord(
      await callRpc<unknown>(
        this.transport,
        'agentPreset.copy',
        { from, agentPreset: presetId, ...(name === undefined ? {} : { name }) },
        signal,
      ),
    )
    if (typeof value.agentPreset !== 'string' || value.agentPreset.trim() === '')
      throw malformedPresetResponse('copied preset id')
    return value.agentPreset
  }

  public async openDocument(presetId: string, signal?: AbortSignal): Promise<AgentPresetLocation> {
    const value = await callRpc<unknown>(
      this.transport,
      'agentPreset.openDocument',
      { agentPreset: presetId },
      signal,
    )
    const record = requiredRecord(value)
    if (record.opened === true) return { opened: true }
    if (record.opened === false && typeof record.path === 'string' && record.path.trim() !== '')
      return { opened: false, path: record.path }
    throw malformedPresetResponse('document location')
  }

  public async remove(presetId: string, signal?: AbortSignal): Promise<void> {
    const value = await callRpc<unknown>(
      this.transport,
      'agentPreset.remove',
      { agentPreset: presetId },
      signal,
    )
    assertEmptyReceipt(value)
  }
}

function presetDescriptor(value: unknown): AgentPresetDescriptor {
  const record = requiredRecord(value)
  if (
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    (record.trust !== 'system' && record.trust !== 'user') ||
    typeof record.isDefault !== 'boolean' ||
    (record.name !== undefined && typeof record.name !== 'string') ||
    (record.description !== undefined && typeof record.description !== 'string') ||
    (record.broken !== undefined && (typeof record.broken !== 'string' || record.broken.length === 0))
  )
    throw malformedPresetResponse('roster entry')
  return {
    id: record.id,
    trust: record.trust,
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
    message: `DSH returned a malformed preset ${part}.`,
    retryable: false,
  })
}

function assertEmptyReceipt(value: unknown): void {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)
    return
  throw malformedPresetResponse('remove receipt')
}
