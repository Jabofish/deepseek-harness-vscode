import type { BackendEvent, GoalView, JobView, SubagentView } from './events.js'
import type {
  DshSettingsSchema,
  DynamicCommand,
  PluginDescriptor,
  SessionExportOptions,
  SkillDescriptor,
  WorkflowSummary,
} from './advanced.js'
import type { AgentConfiguration, ModelDescriptor, ModelProvider } from './models.js'
import type { ConnectedBackend } from './runtime.js'
import type {
  PromptInput,
  QueuedInput,
  RunningInputMode,
  SessionCreateInput,
  SessionDetail,
  SessionListQuery,
  SessionPage,
} from './sessions.js'
import type { PermissionOption } from './tools.js'
import type { WorkspaceCreateInput, WorkspaceSummary } from './workspaces.js'

export interface AsyncEventSource<T> {
  subscribe(listener: (event: T) => void): () => void
  close(): Promise<void>
}

export interface SessionRepository {
  list(query?: SessionListQuery, signal?: AbortSignal): Promise<SessionPage>
  get(sessionId: string, signal?: AbortSignal): Promise<SessionDetail>
  create(input: SessionCreateInput, signal?: AbortSignal): Promise<SessionDetail>
  remove(sessionId: string, signal?: AbortSignal): Promise<void>
  rename(sessionId: string, title: string, signal?: AbortSignal): Promise<void>
  fork(sessionId: string, signal?: AbortSignal): Promise<SessionDetail>
  setArchived(sessionId: string, archived: boolean, signal?: AbortSignal): Promise<void>
  sendPrompt(input: PromptInput, signal?: AbortSignal): Promise<void>
  enqueuePrompt(input: PromptInput, mode: RunningInputMode, signal?: AbortSignal): Promise<QueuedInput>
  listQueue(sessionId: string, signal?: AbortSignal): Promise<readonly QueuedInput[]>
  updateQueuedInput(inputId: string, text: string, signal?: AbortSignal): Promise<void>
  removeQueuedInput(inputId: string, signal?: AbortSignal): Promise<void>
  convertQueuedInputToSteer(inputId: string, signal?: AbortSignal): Promise<void>
  cancel(sessionId: string, signal?: AbortSignal): Promise<void>
  setConfiguration(sessionId: string, configuration: AgentConfiguration, signal?: AbortSignal): Promise<void>
}

export interface WorkspaceRepository {
  list(signal?: AbortSignal): Promise<readonly WorkspaceSummary[]>
  create(input: WorkspaceCreateInput, signal?: AbortSignal): Promise<WorkspaceSummary>
  rename(workspaceId: string, name: string, signal?: AbortSignal): Promise<void>
  remove(workspaceId: string, signal?: AbortSignal): Promise<void>
}

export interface ModelRepository {
  listProviders(signal?: AbortSignal): Promise<readonly ModelProvider[]>
  listModels(providerId?: string, signal?: AbortSignal): Promise<readonly ModelDescriptor[]>
}

export interface CredentialRepository {
  setSecret(providerId: string, field: string, value: string, signal?: AbortSignal): Promise<void>
  removeSecret(providerId: string, field: string, signal?: AbortSignal): Promise<void>
}

export interface InteractionRepository {
  respondToPermission(requestId: string, option: PermissionOption, signal?: AbortSignal): Promise<void>
  respondToQuestion(
    questionId: string,
    response: string | readonly string[],
    signal?: AbortSignal,
  ): Promise<void>
}

export interface GoalRepository {
  list(sessionId: string, signal?: AbortSignal): Promise<readonly GoalView[]>
  create(sessionId: string, title: string, signal?: AbortSignal): Promise<GoalView>
  update(
    goalId: string,
    update: Partial<Pick<GoalView, 'title' | 'status'>>,
    signal?: AbortSignal,
  ): Promise<void>
}

export interface JobRepository {
  list(sessionId: string, signal?: AbortSignal): Promise<readonly JobView[]>
  cancel(jobId: string, signal?: AbortSignal): Promise<void>
}

export interface SubagentRepository {
  list(sessionId: string, signal?: AbortSignal): Promise<readonly SubagentView[]>
  send(sessionId: string, message: string, signal?: AbortSignal): Promise<void>
  interrupt(sessionId: string, signal?: AbortSignal): Promise<void>
}

export interface SettingsRepository {
  schema(signal?: AbortSignal): Promise<DshSettingsSchema>
  read(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>
  update(path: string, value: unknown, signal?: AbortSignal): Promise<void>
  replace(value: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<void>
}

export interface WorkflowRepository {
  list(sessionId: string, signal?: AbortSignal): Promise<readonly WorkflowSummary[]>
  start(sessionId: string, workflowId: string, signal?: AbortSignal): Promise<WorkflowSummary>
  cancel(workflowId: string, signal?: AbortSignal): Promise<void>
}

export interface SkillRepository {
  list(signal?: AbortSignal): Promise<readonly SkillDescriptor[]>
  refresh(signal?: AbortSignal): Promise<readonly SkillDescriptor[]>
  execute(sessionId: string, skillId: string, input: string, signal?: AbortSignal): Promise<void>
}

export interface CommandRepository {
  list(sessionId?: string, signal?: AbortSignal): Promise<readonly DynamicCommand[]>
  execute(sessionId: string, command: string, signal?: AbortSignal): Promise<void>
}

export interface PluginRepository {
  list(signal?: AbortSignal): Promise<readonly PluginDescriptor[]>
  configure(pluginId: string, enabled: boolean, signal?: AbortSignal): Promise<void>
}

export interface ExportRepository {
  exportSession(options: SessionExportOptions, destination: string, signal?: AbortSignal): Promise<void>
}

export interface DshBackend {
  readonly connection: ConnectedBackend
  readonly sessions: SessionRepository
  readonly workspaces: WorkspaceRepository
  readonly models: ModelRepository
  readonly credentials: CredentialRepository
  readonly interactions: InteractionRepository
  readonly goals: GoalRepository
  readonly jobs: JobRepository
  readonly subagents: SubagentRepository
  readonly settings: SettingsRepository
  readonly workflows: WorkflowRepository
  readonly skills: SkillRepository
  readonly commands: CommandRepository
  readonly plugins: PluginRepository
  readonly exports: ExportRepository
  readonly events: AsyncEventSource<BackendEvent>
  close(): Promise<void>
}
