import { AppError } from '@dsh-vscode/domain'
import type {
  AgentPresetDocument,
  DynamicCommand,
  AgentPresetLocation,
  AgentPresetRoster,
  GoalView,
  JobView,
  PluginInventorySnapshot,
  SkillDescriptor,
  SubagentCatalog,
  SubagentHistoryPage,
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

  public listSubagentHistory(sessionId: string, signal?: AbortSignal): Promise<SubagentHistoryPage> {
    const repository = this.backendService.requireBackend().subagents
    if (repository.history === undefined) return Promise.reject(unavailable('subagent history'))
    // Invoke through the repository object: rc.6 history resolves the durable
    // parent/child address from its catalog cache and therefore requires its
    // method receiver.
    return repository.history(sessionId, signal)
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
    const read = this.backendService.requireBackend().presets.read
    if (read === undefined) return Promise.reject(unavailable('preset read'))
    return read(presetId, signal)
  }

  public copyPreset(from: string, presetId: string, name?: string, signal?: AbortSignal): Promise<string> {
    const copy = this.backendService.requireBackend().presets.copy
    if (copy === undefined) return Promise.reject(unavailable('preset copy'))
    return copy(from, presetId, name, signal)
  }

  public openPresetDocument(presetId: string, signal?: AbortSignal): Promise<AgentPresetLocation> {
    const open = this.backendService.requireBackend().presets.openDocument
    if (open === undefined) return Promise.reject(unavailable('preset document opening'))
    return open(presetId, signal)
  }

  public removePreset(presetId: string, signal?: AbortSignal): Promise<void> {
    const remove = this.backendService.requireBackend().presets.remove
    if (remove === undefined) return Promise.reject(unavailable('preset removal'))
    return remove(presetId, signal)
  }

  /**
   * The host's read-only plugin inventory — the pinned rc.6 contract exposes
   * `pluginInventory/list` only; plugins are composed by the deployment and
   * never toggled from a client.
   */
  public pluginInventory(signal?: AbortSignal): Promise<PluginInventorySnapshot> {
    return this.backendService.requireBackend().plugins.inventory(signal)
  }

  public execute(
    capability: 'subagent.send' | 'subagent.interrupt' | 'skill.execute' | 'command.execute',
    input: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<void> {
    const backend = this.backendService.requireBackend()
    switch (capability) {
      case 'subagent.send':
        return backend.subagents.send(
          requiredString(input, 'sessionId'),
          requiredString(input, 'message'),
          signal,
        )
      case 'subagent.interrupt':
        return backend.subagents.interrupt(requiredString(input, 'sessionId'), signal)
      case 'skill.execute':
        return backend.skills.execute(
          requiredString(input, 'sessionId'),
          requiredString(input, 'skillId'),
          typeof input.input === 'string' ? input.input : '',
          signal,
        )
      case 'command.execute':
        return backend.commands.execute(
          requiredString(input, 'sessionId'),
          requiredString(input, 'command'),
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
