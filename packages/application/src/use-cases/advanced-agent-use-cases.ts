import { AppError } from '@dsh-vscode/domain'
import type {
  AgentPresetDocument,
  DynamicCommand,
  AgentPresetDescriptor,
  GoalView,
  JobView,
  PluginDescriptor,
  SkillDescriptor,
  SubagentHistoryPage,
  SubagentView,
  WorkflowSummary,
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

  public listSubagents(sessionId: string, signal?: AbortSignal): Promise<readonly SubagentView[]> {
    return this.backendService.requireBackend().subagents.list(sessionId, signal)
  }

  public listSubagentHistory(sessionId: string, signal?: AbortSignal): Promise<SubagentHistoryPage> {
    const history = this.backendService.requireBackend().subagents.history
    if (history === undefined) return Promise.reject(unavailable('subagent history'))
    return history(sessionId, signal)
  }

  public listWorkflows(sessionId: string, signal?: AbortSignal): Promise<readonly WorkflowSummary[]> {
    return this.backendService.requireBackend().workflows.list(sessionId, signal)
  }

  public listSkills(sessionId?: string, signal?: AbortSignal): Promise<readonly SkillDescriptor[]> {
    return this.backendService.requireBackend().skills.list(sessionId, signal)
  }

  public listCommands(sessionId?: string, signal?: AbortSignal): Promise<readonly DynamicCommand[]> {
    return this.backendService.requireBackend().commands.list(sessionId, signal)
  }

  public listPresets(signal?: AbortSignal): Promise<readonly AgentPresetDescriptor[]> {
    return this.backendService.requireBackend().presets.list(signal)
  }

  public selectPreset(sessionId: string, presetId: string, signal?: AbortSignal): Promise<void> {
    return this.backendService.requireBackend().presets.select(sessionId, presetId, signal)
  }

  public clearGoal(goalId: string, signal?: AbortSignal): Promise<void> {
    const clear = this.backendService.requireBackend().goals.clear
    if (clear === undefined) return Promise.reject(unavailable('goal clear'))
    return clear(goalId, signal)
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

  public openPresetDocument(presetId: string, signal?: AbortSignal): Promise<{ readonly opened: boolean }> {
    const open = this.backendService.requireBackend().presets.openDocument
    if (open === undefined) return Promise.reject(unavailable('preset document opening'))
    return open(presetId, signal)
  }

  public removePreset(presetId: string, signal?: AbortSignal): Promise<void> {
    const remove = this.backendService.requireBackend().presets.remove
    if (remove === undefined) return Promise.reject(unavailable('preset removal'))
    return remove(presetId, signal)
  }

  public listPlugins(signal?: AbortSignal): Promise<readonly PluginDescriptor[]> {
    return this.backendService.requireBackend().plugins.list(signal)
  }

  public execute(
    capability:
      | 'job.cancel'
      | 'subagent.send'
      | 'subagent.interrupt'
      | 'workflow.start'
      | 'workflow.cancel'
      | 'skill.execute'
      | 'command.execute'
      | 'plugin.configure',
    input: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<void> {
    const backend = this.backendService.requireBackend()
    switch (capability) {
      case 'job.cancel':
        return backend.jobs.cancel(requiredString(input, 'jobId'), signal)
      case 'subagent.send':
        return backend.subagents.send(
          requiredString(input, 'sessionId'),
          requiredString(input, 'message'),
          signal,
        )
      case 'subagent.interrupt':
        return backend.subagents.interrupt(requiredString(input, 'sessionId'), signal)
      case 'workflow.start':
        return backend.workflows
          .start(requiredString(input, 'sessionId'), requiredString(input, 'workflowId'), signal)
          .then(() => undefined)
      case 'workflow.cancel':
        return backend.workflows.cancel(requiredString(input, 'workflowId'), signal)
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
      case 'plugin.configure':
        return backend.plugins.configure(
          requiredString(input, 'pluginId'),
          requiredBoolean(input, 'enabled'),
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

function requiredBoolean(input: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = input[key]
  if (typeof value !== 'boolean') throw new Error(`${key} is required`)
  return value
}
