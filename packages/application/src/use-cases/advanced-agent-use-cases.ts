import { AppError } from '@dsh-vscode/domain'
import type {
  AgentPresetDocument,
  DynamicCommand,
  AgentPresetLocation,
  AgentPresetRoster,
  CommandExecutionResult,
  GoalView,
  JobView,
  PluginInventorySnapshot,
  PromptAttachment,
  SkillDescriptor,
  SubagentCatalog,
  SubagentHistoryPage,
  SubagentHistoryQuery,
} from '@dsh-vscode/domain'

import type { BackendService } from '../services/backend-service.js'

export class AdvancedAgentUseCases {
  public constructor(private readonly backendService: BackendService) {}

  public listGoals(sessionId: string, signal?: AbortSignal): Promise<readonly GoalView[]> {
    return this.backendService.requireBackend().goals.list(sessionId, signal)
  }

  public listJobs(sessionId: string, signal?: AbortSignal): Promise<readonly JobView[]> {
    return this.backendService.requireBackend().jobs.list(sessionId, signal)
  }

  public listSubagents(sessionId: string, signal?: AbortSignal): Promise<SubagentCatalog> {
    return this.backendService.requireBackend().subagents.list(sessionId, signal)
  }

  public listSubagentHistory(
    sessionId: string,
    query?: SubagentHistoryQuery,
    signal?: AbortSignal,
  ): Promise<SubagentHistoryPage> {
    const repository = this.backendService.requireBackend().subagents
    if (repository.history === undefined) return Promise.reject(unavailable('subagent history'))
    // Invoke through the repository object: rc.6 history resolves the durable
    // parent/child address from its catalog cache and therefore requires its
    // method receiver.
    return repository.history(sessionId, query, signal)
  }

  public listSkills(sessionId?: string, signal?: AbortSignal): Promise<readonly SkillDescriptor[]> {
    return this.backendService.requireBackend().skills.list(sessionId, signal)
  }

  public listCommands(sessionId?: string, signal?: AbortSignal): Promise<readonly DynamicCommand[]> {
    return this.backendService.requireBackend().commands.list(sessionId, signal)
  }

  public listPresets(signal?: AbortSignal): Promise<AgentPresetRoster> {
    return this.backendService.requireBackend().presets.list(signal)
  }

  public selectPreset(sessionId: string, presetId: string, signal?: AbortSignal): Promise<void> {
    return this.backendService.requireBackend().presets.select(sessionId, presetId, signal)
  }

  public clearGoal(goalId: string, signal?: AbortSignal): Promise<void> {
    const repository = this.backendService.requireBackend().goals
    if (repository.clear === undefined) return Promise.reject(unavailable('goal clear'))
    return repository.clear(goalId, signal)
  }

  public readPreset(presetId: string, signal?: AbortSignal): Promise<AgentPresetDocument> {
    const repository = this.backendService.requireBackend().presets
    if (repository.read === undefined) return Promise.reject(unavailable('preset read'))
    // Keep the call on the repository object: adapter methods use `this.transport`.
    return repository.read(presetId, signal)
  }

  public copyPreset(from: string, presetId: string, name?: string, signal?: AbortSignal): Promise<string> {
    const repository = this.backendService.requireBackend().presets
    if (repository.copy === undefined) return Promise.reject(unavailable('preset copy'))
    return repository.copy(from, presetId, name, signal)
  }

  public openPresetDocument(presetId: string, signal?: AbortSignal): Promise<AgentPresetLocation> {
    const repository = this.backendService.requireBackend().presets
    if (repository.openDocument === undefined) return Promise.reject(unavailable('preset document opening'))
    return repository.openDocument(presetId, signal)
  }

  public removePreset(presetId: string, signal?: AbortSignal): Promise<void> {
    const repository = this.backendService.requireBackend().presets
    if (repository.remove === undefined) return Promise.reject(unavailable('preset removal'))
    return repository.remove(presetId, signal)
  }

  /**
   * The host's read-only plugin inventory — the pinned rc.6 contract exposes
   * `pluginInventory/list` only; plugins are composed by the deployment and
   * never toggled from a client.
   */
  public pluginInventory(signal?: AbortSignal): Promise<PluginInventorySnapshot> {
    return this.backendService.requireBackend().plugins.inventory(signal)
  }

  public async execute(
    capability: 'subagent.send' | 'subagent.interrupt' | 'skill.execute' | 'command.execute',
    input: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<CommandExecutionResult | undefined> {
    const backend = this.backendService.requireBackend()
    switch (capability) {
      case 'subagent.send':
        await backend.subagents.send(
          requiredString(input, 'sessionId'),
          requiredString(input, 'message'),
          signal,
        )
        return undefined
      case 'subagent.interrupt':
        await backend.subagents.interrupt(requiredString(input, 'sessionId'), signal)
        return undefined
      case 'skill.execute':
        await backend.skills.execute(
          requiredString(input, 'sessionId'),
          requiredString(input, 'skillId'),
          typeof input.input === 'string' ? input.input : '',
          signal,
        )
        return undefined
      case 'command.execute':
        return backend.commands.execute(
          requiredString(input, 'sessionId'),
          requiredString(input, 'command'),
          promptAttachments(input.attachments),
          signal,
        )
    }
  }
}

function unavailable(capability: string): AppError {
  return new AppError({
    code: 'CAPABILITY_UNAVAILABLE',
    message: `The connected DSH does not expose ${capability}.`,
    retryable: false,
  })
}

function requiredString(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} is required`)
  return value
}

function promptAttachments(value: unknown): readonly PromptAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw malformedAttachment(0)
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw malformedAttachment(index)
    const record = entry as Record<string, unknown>
    if (
      typeof record.uri !== 'string' ||
      record.uri.trim() === '' ||
      typeof record.name !== 'string' ||
      record.name.trim() === '' ||
      (record.mimeType !== undefined &&
        (typeof record.mimeType !== 'string' || record.mimeType.trim() === ''))
    )
      throw malformedAttachment(index)
    return {
      uri: record.uri,
      name: record.name,
      ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
    }
  })
}

function malformedAttachment(index: number): AppError {
  return new AppError({
    code: 'INVALID_CONFIGURATION',
    message: 'The command contains a malformed attachment.',
    retryable: false,
    context: { attachmentIndex: index },
  })
}
