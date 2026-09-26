import type {
  AgentPresetDescriptor,
  AgentPresetDocument,
  AgentPresetRoster,
  PresetRepository,
} from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'

import type { DshTransport } from '../../contracts.js'
import { unwrapRpcResultValue } from '../rc6/rpc.js'

// Mirrors dsh-v0.1.7-rc.2's agent-preset-registry/display.ts classifier:
// shipped rows have one of these ids and publish no name; named or other rows
// are custom presets. The Remote roster and read document carry no trust field.
const RC172_BUILT_IN_PRESET_IDS = new Set(['standard', 'ptc', 'minimal', 'cordis'])
const LIST_AGENT_PRESETS = 'agentPresets/list'

/** DSH 0.1.7-rc.2's registry-backed preset surface. */
export class Rc172PresetRepository implements PresetRepository {
  public constructor(private readonly transport: DshTransport) {}

  public async list(signal?: AbortSignal): Promise<AgentPresetRoster> {
    try {
      const value = unwrapRpcResultValue<unknown>(
        await this.transport.remoteRequest(LIST_AGENT_PRESETS, {}, signal),
        LIST_AGENT_PRESETS,
      )
      const record = requiredRecord(value, 'roster')
      if (!Array.isArray(record.presets)) throw malformedPresetResponse('roster')

      return {
        presets: record.presets.map(presetDescriptor),
        authorable: false,
        canOpenPresetLocation: false,
        canRemoveUserPresets: false,
        compositionReadable: true,
        defaultSettingPath: 'agent-preset-registry.selectedDefault',
      }
    } catch (error) {
      if (!isOptionalRegistryUnavailable(error)) throw error
      // RC2 permits profiles without the preset registry.  An unavailable
      // invocation has no roster or default to project; leave session creation
      // to the host's own composition and default.
      return {
        presets: [],
        authorable: false,
        canOpenPresetLocation: false,
        canRemoveUserPresets: false,
        compositionReadable: false,
      }
    }
  }

  public async read(presetId: string, signal?: AbortSignal): Promise<AgentPresetDocument> {
    requireIdentifier(presetId, 'preset')
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest('agentPresets/read', { agentPreset: presetId }, signal),
      'agentPresets/read',
    )
    const record = requiredRecord(value, 'document')
    if (
      !isNonEmptyString(record.agentPreset) ||
      record.agentPreset !== presetId ||
      typeof record.content !== 'string' ||
      (record.name !== undefined && typeof record.name !== 'string') ||
      (record.description !== undefined && typeof record.description !== 'string')
    )
      throw malformedPresetResponse('document')

    return {
      id: record.agentPreset,
      trust: presetTrust(record.agentPreset, record.name),
      content: record.content,
      ...(record.name === undefined ? {} : { name: record.name }),
      ...(record.description === undefined ? {} : { description: record.description }),
    }
  }

  public async select(sessionId: string, presetId: string, signal?: AbortSignal): Promise<void> {
    requireIdentifier(sessionId, 'session')
    requireIdentifier(presetId, 'preset')
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest(
        'agentPresets/select',
        { agentId: sessionId, agentPreset: presetId },
        signal,
      ),
      'agentPresets/select',
    )
    if (value !== presetId) throw malformedPresetResponse('selection receipt')
  }
}

function presetDescriptor(value: unknown): AgentPresetDescriptor {
  const record = requiredRecord(value, 'roster entry')
  if (
    !isNonEmptyString(record.id) ||
    typeof record.isDefault !== 'boolean' ||
    (record.name !== undefined && typeof record.name !== 'string') ||
    (record.description !== undefined && typeof record.description !== 'string') ||
    (record.broken !== undefined && !isNonEmptyString(record.broken))
  )
    throw malformedPresetResponse('roster entry')

  return {
    id: record.id,
    trust: presetTrust(record.id, record.name),
    isDefault: record.isDefault,
    ...(record.name === undefined ? {} : { name: record.name }),
    ...(record.description === undefined ? {} : { description: record.description }),
    ...(record.broken === undefined ? {} : { broken: record.broken }),
  }
}

function presetTrust(id: string, name: unknown): 'system' | 'user' {
  return name === undefined && RC172_BUILT_IN_PRESET_IDS.has(id) ? 'system' : 'user'
}

function isOptionalRegistryUnavailable(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.context?.rpcMethod === LIST_AGENT_PRESETS &&
    error.context.rpcCode === 'gateway/invocation-unavailable'
  )
}

function requiredRecord(value: unknown, part: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value))
    return value as Record<string, unknown>
  throw malformedPresetResponse(part)
}

function requireIdentifier(value: string, part: 'preset' | 'session'): void {
  if (!isNonEmptyString(value))
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: `A DSH ${part} is required for this preset operation.`,
      retryable: false,
    })
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function malformedPresetResponse(part: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed rc172 preset ${part}.`,
    retryable: false,
  })
}
