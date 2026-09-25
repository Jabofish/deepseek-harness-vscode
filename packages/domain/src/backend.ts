import type { WorkspaceChangeSource } from './changes.js'
import type { BackendEvent, GoalView, JobFollowFrame, JobView, SubagentCatalog } from './events.js'
import type { MessageFeedbackRepository } from './feedback.js'
import type { ScheduleRepository } from './schedules.js'
import type { PluginBundleRepository } from './plugin-bundles.js'
import type { AccountLifecycleRepository } from './account-lifecycle.js'
import type { ReferenceRepository } from './references.js'
import type {
  DshSettingsSchema,
  AgentPresetDocument,
  AgentPresetLocation,
  AgentPresetRoster,
  DynamicCommand,
  CommandExecutionResult,
  PluginInventorySnapshot,
  SessionExportOptions,
  SkillDescriptor,
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
  SessionHistoryPage,
  SessionHistoryQueryOptions,
  SessionListQuery,
  SessionPage,
  SubagentHistoryPage,
  SubagentHistoryQuery,
} from './sessions.js'
import type { QuestionAnswer } from './tools.js'
import type { WorkspaceCreateInput, WorkspaceSummary } from './workspaces.js'

export interface AsyncEventSource<T> {
  subscribe(listener: (event: T) => void): () => void
  close(): Promise<void>
  /** Local settlement from a request made by this client, when the wire omits its own echo. */
  publish?(event: T): void
}

export interface SessionRepository {
  /** Whether ordinary prompts accept binary upload receipts. Host-only capability. */
  readonly supportsFileUploads?: boolean
  /** Initialize the backend's default model after a supported account login. */
  readonly initializeDefaultModel?: (signal?: AbortSignal) => Promise<void>
  list(query?: SessionListQuery, signal?: AbortSignal): Promise<SessionPage>
  get(sessionId: string, signal?: AbortSignal): Promise<SessionDetail>
  /**
   * Optional session-open hook. Version adapters may use it to re-baseline a
   * process-local follow stream after the authoritative history read.
   */
  open?(sessionId: string, signal?: AbortSignal): Promise<SessionDetail>
  history(
    sessionId: string,
    beforeSequence?: number,
    signal?: AbortSignal,
    options?: SessionHistoryQueryOptions,
  ): Promise<SessionHistoryPage>
  readAttachment(sessionId: string, attachmentId: string, signal?: AbortSignal): Promise<PromptAttachment>
  create(input: SessionCreateInput, signal?: AbortSignal): Promise<SessionDetail>
  remove(sessionId: string, signal?: AbortSignal): Promise<void>
  /**
   * Rename a session and return the title the host accepted. The host
   * normalizes what it stores (control characters stripped, whitespace
   * collapsed, truncated to its own byte budget), so a caller that displays a
   * title must use this value rather than the requested text.
   */
  rename(sessionId: string, title: string, signal?: AbortSignal): Promise<string>
  fork(sessionId: string, atSeq?: number, signal?: AbortSignal): Promise<SessionDetail>
  setArchived(sessionId: string, archived: boolean, signal?: AbortSignal): Promise<void>
  sendPrompt(input: PromptInput, mode?: RunningInputMode, signal?: AbortSignal): Promise<void>
  enqueuePrompt(input: PromptInput, mode: RunningInputMode, signal?: AbortSignal): Promise<QueuedInput>
  listQueue(sessionId: string, signal?: AbortSignal): Promise<readonly QueuedInput[]>
  updateQueuedInput(inputId: string, text: string, signal?: AbortSignal): Promise<void>
  removeQueuedInput(inputId: string, signal?: AbortSignal): Promise<void>
  convertQueuedInputToSteer(inputId: string, signal?: AbortSignal): Promise<void>
  /** Host-side queue ownership used to authorize id-only queue mutations. */
  readonly sessionForQueuedInput?: (this: SessionRepository, inputId: string) => string | undefined
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
  /** Move a workspace before an optional anchor; omitted anchor appends. */
  insertBefore(workspaceId: string, beforeWorkspaceId?: string, signal?: AbortSignal): Promise<void>
  /** Move a session within its workspace before an optional anchor. */
  insertSessionBefore(
    workspaceId: string,
    sessionId: string,
    beforeSessionId?: string,
    signal?: AbortSignal,
  ): Promise<void>
}

export interface ModelRepository {
  listProviders(signal?: AbortSignal): Promise<readonly ModelProvider[]>
  listModels(providerId?: string, signal?: AbortSignal): Promise<readonly ModelDescriptor[]>
  listSessionModels(sessionId: string, signal?: AbortSignal): Promise<SessionModelCatalog>
  discoverModels(input: ModelDiscoveryInput, signal?: AbortSignal): Promise<readonly DiscoveredModel[]>
}

/** A credential reference's host-side state; the value itself never leaves the host. */
export interface CredentialReferenceState {
  readonly ref: string
  readonly configured: boolean
  readonly writable: boolean
}

export interface CredentialRepository {
  setSecret(providerId: string, field: string, value: string, signal?: AbortSignal): Promise<void>
  removeSecret(providerId: string, field: string, signal?: AbortSignal): Promise<void>
  /** `credentials.describe` for one explicit reference (plugin-owned secrets). */
  describeReference(ref: string, signal?: AbortSignal): Promise<CredentialReferenceState>
  /** `credentials.set` for one explicit reference; the value never transits the Webview. */
  setReference(ref: string, value: string, signal?: AbortSignal): Promise<void>
  /** `credentials.unset` for one explicit reference. */
  unsetReference(ref: string, signal?: AbortSignal): Promise<void>
}

export interface InteractionRepository {
  respondToPermission(requestId: string, optionId: string, signal?: AbortSignal): Promise<void>
  respondToQuestion(
    questionId: string,
    response: string | readonly string[] | readonly QuestionAnswer[],
    signal?: AbortSignal,
  ): Promise<void>
  cancelQuestion(questionId: string, signal?: AbortSignal): Promise<void>
  /** Host-side ownership facts used to authorize Webview interaction routes. */
  readonly sessionForPermission?: (this: InteractionRepository, requestId: string) => string | undefined
  readonly sessionForQuestion?: (this: InteractionRepository, questionId: string) => string | undefined
}

export interface GoalRepository {
  list(sessionId: string, signal?: AbortSignal): Promise<readonly GoalView[]>
  create(sessionId: string, title: string, signal?: AbortSignal, maxGoalRounds?: number): Promise<GoalView>
  update(
    goalId: string,
    update: Partial<Pick<GoalView, 'title' | 'status' | 'maxGoalRounds'>>,
    signal?: AbortSignal,
  ): Promise<void>
  readonly clear?: (this: GoalRepository, goalId: string, signal?: AbortSignal) => Promise<void>
  /** Host-side ownership fact for id-only goal mutations. */
  readonly sessionForGoal?: (this: GoalRepository, goalId: string) => string | undefined
}

export interface JobRepository {
  list(sessionId: string, signal?: AbortSignal): Promise<readonly JobView[]>
  /** Optional continuous whole-roster stream for versions with Job Controller. */
  readonly watchRows?: (
    this: JobRepository,
    sessionId: string,
    signal: AbortSignal,
  ) => AsyncIterable<BackendEvent>
  /** Optional non-consuming output observation stream for versions with Job Controller. */
  readonly follow?: (
    this: JobRepository,
    sessionId: string,
    jobId: string,
    from?: number,
    signal?: AbortSignal,
  ) => AsyncIterable<JobFollowFrame>
  /** Optional human-initiated cancellation supported by Job Controller. */
  readonly kill?: (
    this: JobRepository,
    sessionId: string,
    jobId: string,
    signal?: AbortSignal,
  ) => Promise<'requested' | 'already-finished'>
}

export interface SubagentRepository {
  list(sessionId: string, signal?: AbortSignal): Promise<SubagentCatalog>
  readonly history?: (
    this: SubagentRepository,
    sessionId: string,
    query?: SubagentHistoryQuery,
    signal?: AbortSignal,
  ) => Promise<SubagentHistoryPage>
  /** Preserve the pre-delivery overloads while allowing the alpha.2 mode. */
  send(sessionId: string, message: string, signal?: AbortSignal): Promise<void>
  send(
    sessionId: string,
    message: string,
    attachments?: readonly PromptAttachment[],
    signal?: AbortSignal,
  ): Promise<void>
  send(
    sessionId: string,
    message: string,
    attachments?: readonly PromptAttachment[],
    mode?: RunningInputMode,
    signal?: AbortSignal,
  ): Promise<void>
  interrupt(sessionId: string, signal?: AbortSignal): Promise<void>
  /**
   * Host-side ownership fact for a catalog-resolved child: the durable parent
   * whose workspace membership authorizes child-scoped routes. The Session
   * Controller refuses a session-kind address for a child, so the parent link
   * cannot be re-derived from an ordinary session detail read.
   */
  readonly parentOf?: (this: SubagentRepository, childSessionId: string) => string | undefined
}

export interface SettingsRepository {
  schema(signal?: AbortSignal): Promise<DshSettingsSchema>
  read(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>
  /** Ask the host to open its configured local settings document. */
  readonly openDocument?: (this: SettingsRepository, signal?: AbortSignal) => Promise<void>
  update(path: string, value: unknown, signal?: AbortSignal): Promise<void>
  /** Remove one field's user override (`settings.mutate` op `unset`); the composition base resurfaces. */
  unset(path: string, signal?: AbortSignal): Promise<void>
  /** Apply one atomic ordered operation batch against a namespace. */
  mutate(
    namespace: string,
    operations: readonly SettingsPathOperation[],
    expectedRevision?: number,
    signal?: AbortSignal,
  ): Promise<void>
  replace(value: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<void>
}

/** One strict path operation accepted by the pinned DSH `settings.mutate` RPC. */
export type SettingsPathOperation =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

export interface SkillRepository {
  list(sessionId?: string, signal?: AbortSignal): Promise<readonly SkillDescriptor[]>
  refresh(sessionId?: string, signal?: AbortSignal): Promise<readonly SkillDescriptor[]>
  execute(sessionId: string, skillId: string, input: string, signal?: AbortSignal): Promise<void>
}

export interface CommandRepository {
  list(sessionId?: string, signal?: AbortSignal): Promise<readonly DynamicCommand[]>
  execute(
    sessionId: string,
    command: string,
    attachments?: readonly PromptAttachment[] | AbortSignal,
    signal?: AbortSignal,
  ): Promise<CommandExecutionResult>
}

/**
 * The host's plugin inventory — a read-only direct-Remote projection. The
 * pinned rc.6 contract publishes no mutation path: plugins are composed by
 * the deployment, never toggled from a client.
 */
export interface PluginRepository {
  inventory(signal?: AbortSignal): Promise<PluginInventorySnapshot>
}

export interface PresetRepository {
  list(signal?: AbortSignal): Promise<AgentPresetRoster>
  select(sessionId: string, presetId: string, signal?: AbortSignal): Promise<void>
  readonly read?: (
    this: PresetRepository,
    presetId: string,
    signal?: AbortSignal,
  ) => Promise<AgentPresetDocument>
  readonly copy?: (
    this: PresetRepository,
    from: string,
    presetId: string,
    name?: string,
    signal?: AbortSignal,
  ) => Promise<string>
  readonly openDocument?: (
    this: PresetRepository,
    presetId: string,
    signal?: AbortSignal,
  ) => Promise<AgentPresetLocation>
  readonly remove?: (this: PresetRepository, presetId: string, signal?: AbortSignal) => Promise<void>
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
  /** Optional account lifecycle exposed only by the exact RC2 profile. */
  readonly account?: AccountLifecycleRepository
  readonly workspaceChanges?: WorkspaceChangeSource
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
  readonly skills: SkillRepository
  readonly commands: CommandRepository
  readonly plugins: PluginRepository
  /** Optional RC2 profile-wide controls for installation-provided optional bundles. */
  readonly pluginBundles?: PluginBundleRepository
  readonly presets: PresetRepository
  /** Optional until the connected exact DSH contract exposes Schedule Remote. */
  readonly schedules?: ScheduleRepository
  readonly exports: ExportRepository
  readonly references: ReferenceRepository
  readonly feedback: MessageFeedbackRepository
  readonly events: AsyncEventSource<BackendEvent>
  close(): Promise<void>
}
