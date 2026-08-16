import type {
  DynamicCommand,
  GoalView,
  JobView,
  PluginDescriptor,
  SkillDescriptor,
  SubagentView,
  WorkflowSummary,
} from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { BackendService } from '../services/backend-service.js'

export class AdvancedAgentUseCases {
  public constructor(private readonly backendService: BackendService) {}

  public listGoals(sessionId: string, signal?: AbortSignal): Promise<readonly GoalView[]> {
    return this.todo('list goals and todos', sessionId, signal)
  }

  public listJobs(sessionId: string, signal?: AbortSignal): Promise<readonly JobView[]> {
    return this.todo('list background jobs', sessionId, signal)
  }

  public listSubagents(sessionId: string, signal?: AbortSignal): Promise<readonly SubagentView[]> {
    return this.todo('list subagent tree', sessionId, signal)
  }

  public listWorkflows(sessionId: string, signal?: AbortSignal): Promise<readonly WorkflowSummary[]> {
    return this.todo('list Workflow and Ralph state', sessionId, signal)
  }

  public listSkills(signal?: AbortSignal): Promise<readonly SkillDescriptor[]> {
    return this.todo('list dynamically discovered skills', 'global', signal)
  }

  public listCommands(sessionId?: string, signal?: AbortSignal): Promise<readonly DynamicCommand[]> {
    return this.todo('list dynamic slash commands', sessionId ?? 'global', signal)
  }

  public listPlugins(signal?: AbortSignal): Promise<readonly PluginDescriptor[]> {
    return this.todo('list DSH plugin inventory', 'global', signal)
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
    return unimplemented<Promise<void>>('execute advanced DSH capability', [
      'validate a capability-specific DTO before selecting the corresponding repository method',
      'never use arbitrary method names or pass an unvalidated record to DSH',
      'require explicit user intent for cancellation, interrupt, plugin configuration, and skill/workflow start',
      'refresh snapshots only where server events cannot confirm the change',
      `capability ${capability}; fields ${Object.keys(input).join(',')}; signal present ${String(signal !== undefined)}`,
    ])
  }

  private todo<T>(feature: string, key: string, signal: AbortSignal | undefined): Promise<T> {
    return unimplemented<Promise<T>>(feature, [
      'delegate to the active domain repository and return stable DTOs',
      'reconcile snapshots with normalized events and preserve unknown future values safely',
      `key ${key}; signal present ${String(signal !== undefined)}; backend guard ${String(this.backendService !== undefined)}`,
    ])
  }
}
