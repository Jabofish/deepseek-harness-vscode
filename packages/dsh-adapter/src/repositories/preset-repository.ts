import type { AgentPresetDescriptor, AgentPresetDocument, PresetRepository } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc } from '../versions/rc6/rpc.js'

export class Rc6PresetRepository implements PresetRepository {
  public constructor(private readonly transport: DshTransport) {}

  public async list(signal?: AbortSignal): Promise<readonly AgentPresetDescriptor[]> {
    const value = await callRpc<{ presets: unknown[] }>(this.transport, 'agentPreset.list', {}, signal)
    return (Array.isArray(value.presets) ? value.presets : []).flatMap((entry) => {
      const record = asRecord(entry)
      if (typeof record.id !== 'string' || (record.trust !== 'system' && record.trust !== 'user')) return []
      return [
        {
          id: record.id,
          trust: record.trust,
          isDefault: record.isDefault === true,
          ...(typeof record.name === 'string' ? { name: record.name } : {}),
          ...(typeof record.description === 'string' ? { description: record.description } : {}),
          ...(typeof record.broken === 'string' ? { broken: record.broken } : {}),
        },
      ]
    })
  }

  public async select(sessionId: string, presetId: string, signal?: AbortSignal): Promise<void> {
    await callRpc(this.transport, 'agentPreset.select', { sessionId, agentPreset: presetId }, signal)
  }

  public async read(presetId: string, signal?: AbortSignal): Promise<AgentPresetDocument> {
    const value = await callRpc<Record<string, unknown>>(
      this.transport,
      'agentPreset.read',
      { agentPreset: presetId },
      signal,
    )
    const record = asRecord(value)
    if (
      typeof record.agentPreset !== 'string' ||
      (record.trust !== 'system' && record.trust !== 'user') ||
      typeof record.content !== 'string'
    )
      throw new Error('DSH returned a malformed preset document.')
    return {
      id: record.agentPreset,
      trust: record.trust,
      content: record.content,
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
    }
  }

  public async copy(from: string, presetId: string, name?: string, signal?: AbortSignal): Promise<string> {
    const value = await callRpc<{ agentPreset: string }>(
      this.transport,
      'agentPreset.copy',
      { from, agentPreset: presetId, ...(name === undefined ? {} : { name }) },
      signal,
    )
    if (typeof value.agentPreset !== 'string' || value.agentPreset.length === 0)
      throw new Error('DSH returned a malformed copied preset id.')
    return value.agentPreset
  }

  public async openDocument(presetId: string, signal?: AbortSignal): Promise<{ readonly opened: boolean }> {
    const value = await callRpc<{ opened: boolean; path?: unknown }>(
      this.transport,
      'agentPreset.openDocument',
      { agentPreset: presetId },
      signal,
    )
    return { opened: value.opened === true }
  }

  public async remove(presetId: string, signal?: AbortSignal): Promise<void> {
    await callRpc(this.transport, 'agentPreset.remove', { agentPreset: presetId }, signal)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
