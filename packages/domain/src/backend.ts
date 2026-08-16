import type { BackendEvent, GoalView, JobView, SubagentView } from './events.js'
import type {
  DshSettingsSchema,
  AgentPresetDescriptor,
  AgentPresetDocument,
  DynamicCommand,
  PluginDescriptor,
  SessionExportOptions,
  SkillDescriptor,
  WorkflowSummary,
} from './advanced.js'
import type {
  AgentConfiguration,
  DiscoveredModel,
  ModelDescriptor,
  ModelDiscoveryInput,
  ModelProvider,
  SessionModelCatalog,
} from './models.js'
import type { ConnectedBackend } from './runtime.js'
import type {
  PromptInput,
  PromptAttachment,
  QueuedInput,
  RunningInputMode,
  SessionCreateInput,
  SessionDetail,
  SessionListQuery,
  SessionPage,
  SubagentHistoryPage,
} from './sessions.js'
import type { QuestionAnswer } from './tools.js'
import type { WorkspaceCreateInput, WorkspaceSummary } from './workspaces.js'

export interface AsyncEventSource<T> {
  subscribe(listener: (event: T) => void): () => void
  close(): Promise<void>
}

export interface SessionRepository {
  list(query?: SessionListQuery, signal?: AbortSignal): Promise<SessionPage>
  get(sessionId: string, signal?: AbortSignal): Promise<SessionDetail>
  readAttachment(sessionId: string, attachmentId: string, signal?: AbortSignal): Promise<PromptAttachment>
  create(input: SessionCreateInput, signal?: AbortSignal): Promise<SessionDetail>
  remove(sessionId: string, signal?: AbortSignal): Promise<void>
  rename(sessionId: string, title: string, signal?: AbortSignal): Promise<void>
  fork(sessionId: string, atSeq?: number, signal?: AbortSignal): Promise<SessionDetail>
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
  /** Return the host's authoritative archive set for the current DSH registry. */
  listArchivedSessionIds(signal?: AbortSignal): Promise<readonly string[]>
  create(input: WorkspaceCreateInput, signal?: AbortSignal): Promise<WorkspaceSummary>
  rename(workspaceId: string, name: string, signal?: AbortSignal): Promise<void>
  remove(workspaceId: string, signal?: AbortSignal): Promise<void>
}

export interface ModelRepository {
  listProviders(signal?: AbortSignal): Promise<readonly ModelProvider[]>
  listModels(providerId?: string, signal?: AbortSignal): Promise<readonly ModelDescriptor[]>
  listSessionModels(sessionId: string, signal?: AbortSignal): Promise<SessionModelCatalog>
  discoverModels(input: ModelDiscoveryInput, signal?: AbortSignal): Promise<readonly DiscoveredModel[]>
}

export interface CredentialRepository {
  setSecret(providerId: string, field: string, value: string, signal?: AbortSignal): Promise<void>
  removeSecret(providerId: string, field: string, signal?: AbortSignal): Promise<void>
}

export interface InteractionRepository {
  respondToPermission(requestId: string, optionId: string, signal?: AbortSignal): Promise<void>
  respondToQuestion(
    questionId: string,
    response: string | readonly string[] | readonly QuestionAnswer[],
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
  readonly clear?: (goalId: string, signal?: AbortSignal) => Promise<void>
}

export interface JobRepository {
  list(sessionId: string, signal?: AbortSignal): Promise<readonly JobView[]>
  cancel(jobId: string, signal?: AbortSignal): Promise<void>
}

export interface SubagentRepository {
  list(sessionId: string, signal?: AbortSignal): Promise<readonly SubagentView[]>
  readonly history?: (sessionId: string, signal?: AbortSignal) => Promise<SubagentHistoryPage>
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
  list(sessionId?: string, signal?: AbortSignal): Promise<readonly SkillDescriptor[]>
  refresh(sessionId?: string, signal?: AbortSignal): Promise<readonly SkillDescriptor[]>
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

export interface PresetRepository {
  list(signal?: AbortSignal): Promise<readonly AgentPresetDescriptor[]>
  select(sessionId: string, presetId: string, signal?: AbortSignal): Promise<void>
  readonly read?: (presetId: string, signal?: AbortSignal) => Promise<AgentPresetDocument>
  readonly copy?: (from: string, presetId: string, name?: string, signal?: AbortSignal) => Promise<string>
  readonly openDocument?: (presetId: string, signal?: AbortSignal) => Promise<{ readonly opened: boolean }>
  readonly remove?: (presetId: string, signal?: AbortSignal) => Promise<void>
}

export interface ExportRepository {
  exportSession(
    options: SessionExportOptions,
    destination: string,
    signal?: AbortSignal,
    overwriteConfirmed?: boolean,
  ): Promise<void>
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
  readonly presets: PresetRepository
  readonly exports: ExportRepository
  readonly events: AsyncEventSource<BackendEvent>
  close(): Promise<void>
}
