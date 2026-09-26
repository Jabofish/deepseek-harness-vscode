import type {
  FeatureHostEvent,
  FeatureRequest,
  AccountLifecycleErrorCodeDto,
  AccountLifecycleSnapshotDto,
  AccountSignOutImpactDto,
  AccountProfileDetailsSnapshotDto,
} from '@dsh-vscode/webview-protocol'
import type {
  AgentConfiguration,
  AgentPresetDescriptor,
  AgentPresetDocument,
  AgentPresetLocation,
  AgentPresetRoster,
  ChangeDetail,
  ChangeReviewState,
  ChangeSetFile,
  CheckpointConflictPolicy,
  CheckpointPreview,
  CheckpointSummary,
  CustomProviderCreateResult,
  CustomProviderDraft,
  DshSettingsSchema,
  DshRuntimeUpdateProgress,
  DshUpdateSnapshot,
  DiagnosticsSnapshot,
  DiscoveredModel,
  DynamicCommand,
  EditorContextItem,
  EditorContextKind,
  EditorContextPreview,
  ExtensionSettingsSummary,
  GoalView,
  FeedbackCategory,
  JobView,
  MessageFeedbackItem,
  MessageFeedbackRating,
  MessageImageReference,
  ModelCatalogFailure,
  ModelDescriptor,
  ModelDiscoveryInput,
  ModelProvider,
  ModelSelection,
  PermissionRequest,
  PluginInventorySnapshot,
  PluginInstallProgressView,
  PromptTemplate,
  PromptTemplateDraft,
  PromptTemplateInsertion,
  PromptMode,
  PromptTemplateScope,
  PromptTemplateSummary,
  PromptTemplateUpdate,
  PromptAttachment,
  QuestionAnswer,
  QueuedInput,
  RunningInputMode,
  SessionExportOptions,
  SessionHistoryEvent,
  SessionPage,
  SessionSummary,
  SettingsPathOperation,
  TaskListScope,
  TaskSummary,
  SubagentCatalog,
  SubagentView,
  TodoView,
  UserQuestion,
  WorkspaceSummary,
} from '@dsh-vscode/domain'
import type { TimelineState } from '@dsh-vscode/timeline'
import type { JobFollowState } from './job-follow.js'
import type { PluginInstallInput, PluginInstallRecoveryState } from '../plugin-install-recovery.js'

export interface OpenFileCandidate {
  readonly id: string
  readonly name: string
  readonly mimeType?: string
  readonly active: boolean
  readonly supported: boolean
}

/** Safe, host-resolved candidates for the official DSH `@` reference menu. */
export type ReferenceCandidate =
  | {
      readonly id: string
      readonly kind: 'file' | 'directory'
      readonly path: string
      readonly label: string
      readonly description: string
    }
  | {
      readonly id: string
      readonly kind: 'session'
      readonly sessionId: string
      readonly label: string
      readonly description: string
      readonly mention: string
      /** Host session candidates carry this; synthetic child references may omit it. */
      readonly sameWorkspace?: boolean
    }

/** A paste/drop payload whose bytes the Webview already holds as base64. */
export interface IngestedFile {
  readonly name: string
  readonly mimeType?: string
  readonly dataBase64: string
}

/**
 * Host-projected connection state. The Webview deliberately receives only
 * lifecycle facts that are safe and useful to render; endpoint, process
 * handles, command lines, and credentials stay in the Extension Host.
 */
export type WebviewBackendState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'locating-runtime' }
  | { readonly kind: 'discovering' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'connected' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'runtime-missing'; readonly searchedLocations: readonly string[] }
  | { readonly kind: 'failed'; readonly message: string; readonly retryable: boolean }
  | {
      readonly kind: 'port-conflict'
      readonly port: number
      readonly message: string
      readonly retryable: boolean
    }
  | { readonly kind: 'stopping' }

export interface AppState {
  readonly backend: WebviewBackendState
  /** Monotonic opaque counter for a newly observed connected backend epoch. */
  readonly connectionEpoch?: number
  /** Safe connected-host version copied from the Extension Host snapshot. */
  readonly connectedDshVersion: string | undefined
  /** True only when the selected pinned adapter accepts inline subagent images. */
  readonly subagentImagePrompts: boolean
  readonly sessionRestore?: boolean
  readonly jobControllerAvailable: boolean
  /** Safe compatibility warning for an unknown/fallback DSH runtime. */
  readonly dshCompatibilityWarning: string | undefined
  /** Latest Host-owned npm registry snapshot for the DSH runtime. */
  readonly dshUpdate: DshUpdateSnapshot | undefined
  /** Latest phase emitted by the Host while an update request is running. */
  readonly dshUpdateProgress: DshRuntimeUpdateProgress | undefined
  readonly sessions: readonly SessionSummary[]
  /** Whether the Session and Workspace rosters have a usable shared snapshot. */
  readonly sessionDirectoryStatus?: 'loading' | 'ready' | 'error'
  readonly archivedSessionIds: readonly string[]
  /** Rows the host still holds after archiving; loaded on demand. */
  readonly archivedSessions: readonly SessionSummary[]
  readonly workspaces: readonly WorkspaceSummary[]
  readonly activeSessionId: string | undefined
  /** A local New Session draft; no DSH session exists until its first submission. */
  readonly pendingSession:
    | {
        readonly revision: number
        readonly workspaceId: string
        readonly configuration: AgentConfiguration
        readonly createdSessionId?: string
      }
    | undefined
  readonly preferredOpenFileId: string | undefined
  readonly timeline: TimelineState
  /** The bounded, durable history window currently installed in the timeline. */
  readonly history: readonly SessionHistoryEvent[]
  readonly historyHasMore: boolean
  /** Raw sequence boundary used by DSH `session.history(beforeSeq)`. */
  readonly historyBeforeSequence: number | undefined
  readonly historyLoading: boolean
  readonly projections: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly configuration: AgentConfiguration | undefined
  readonly providers: readonly ModelProvider[]
  readonly models: readonly ModelDescriptor[]
  /** Session-scoped model directory; the global catalog remains the Settings source. */
  readonly sessionModels: readonly ModelDescriptor[]
  /** Providers the session directory could not enumerate, with the host's reason. */
  readonly sessionModelFailures: readonly ModelCatalogFailure[]
  /**
   * The route the session's next request will take, as the directory states it.
   * The configuration names a model only once someone chose one, so an unstated
   * configuration is not "no model" — it is this route, which only the host can
   * name. It stays separate from `configuration` so that a control which sends
   * the configuration back never writes a route the session did not choose.
   */
  readonly sessionModelCurrent: ModelSelection | undefined
  /**
   * Whether the host currently lists the session's selection. `undefined`
   * means no directory has answered yet; DSH rc.2 still accepts a prompt for
   * an unlisted model so the runtime can return its actionable error.
   */
  readonly sessionModelRoutable: boolean | undefined
  /**
   * True while the session directory is being read. The seat states the read
   * in progress; without it an unanswered directory is indistinguishable from
   * one the host answered empty.
   */
  readonly sessionModelDirectoryLoading: boolean
  /**
   * The host's own reason the session directory could not be read, `undefined`
   * after a read that answered. A refused read is not an empty directory: the
   * rows shown may still come from the global catalog, so the seat has to say
   * why the session's own directory is missing and offer another read.
   */
  readonly sessionModelDirectoryError: string | undefined
  readonly presets: readonly AgentPresetDescriptor[]
  /** Upstream preset registry may disable the mode chooser for new sessions. */
  readonly presetSelectionEnabled?: boolean | undefined
  readonly permissionPresets: readonly string[]
  readonly commands: readonly DynamicCommand[]
  readonly pluginInventoryRevision: number
  readonly pluginInstallProgress: PluginInstallProgressView | undefined
  readonly pluginInstallOperation: PluginInstallRecoveryState | undefined
  readonly accountLifecycleAvailable: boolean
  readonly accountLifecycle: AccountLifecycleSnapshotDto | null
  readonly accountLifecycleLoading: boolean
  readonly accountLifecycleBusy: boolean
  readonly accountLifecycleImpact: AccountSignOutImpactDto | undefined
  readonly accountSessionExpired: boolean
  readonly accountLifecycleError: AccountLifecycleErrorCodeDto | undefined
  readonly accountLifecycleRequestFailed: boolean
  readonly accountProfileDetails: AccountProfileDetailsSnapshotDto | null
  readonly accountProfileLoading: boolean
  readonly accountProfileRequestFailed: boolean
  readonly goals: readonly GoalView[]
  readonly todos: readonly TodoView[]
  readonly jobs: readonly JobView[]
  readonly jobFollow: JobFollowState | undefined
  /** Feedback keyed by assistant message id for the active session. */
  readonly feedback: Readonly<Record<string, MessageFeedbackItem>>
  /** True after the connected DSH explicitly reports that message feedback is unavailable. */
  readonly feedbackUnavailable?: boolean
  /** Complete direct-child catalog for the active ordinary or child session. */
  readonly subagents: SubagentCatalog
  /** Durable address facts retained when a catalog child is opened. */
  readonly activeSubagent: ActiveSubagent | undefined
  readonly queue: readonly QueuedInput[]
  /** Host-owned editor context chips; captured bytes never enter this state. */
  readonly editorContext: readonly EditorContextItem[]
  readonly editorContextAvailableKinds: readonly EditorContextKind[]
  readonly editorContextLoading: boolean
  readonly changes: readonly ChangeSetFile[]
  readonly changesRefreshFailed: boolean
  readonly changesLoading: boolean
  readonly tasks: readonly TaskSummary[]
  readonly tasksLoading: boolean
  readonly taskScope: TaskListScope
  readonly tasksComplete: boolean
  readonly tasksOmittedSessions: number
  readonly checkpoints: readonly CheckpointSummary[]
  readonly unavailableLists?: readonly string[]
  readonly checkpointsLoading: boolean
  readonly promptTemplates: readonly PromptTemplateSummary[]
  readonly promptTemplatesLoading: boolean
  /** Local semantic workflow profile; only DSH-advertised commands can change host state. */
  readonly promptMode: PromptMode
  readonly permissions: readonly PermissionRequest[]
  readonly questions: readonly UserQuestion[]
  /** Host-side `ui-conversation.busyEnter` preference driving the composer. */
  readonly busyEnter: RunningInputMode
  readonly drawer: 'sessions' | 'jobs' | 'subagents' | 'settings' | 'schedules' | undefined
}

/** Schema-driven DSH host settings snapshot (describe + resolved values). */
export interface DshSettingsSnapshot {
  readonly schema: DshSettingsSchema
  readonly values: Readonly<Record<string, unknown>>
}

export interface AppActions {
  featureRequest<T>(this: void, request: FeatureRequest): Promise<T>
  subscribeFeature(this: void, listener: (message: FeatureHostEvent) => void): () => void
  loadAccountLifecycle(): Promise<void>
  startAccountSignIn(): Promise<void>
  cancelAccountSignIn(attemptId: string): Promise<void>
  checkAccountSignOutImpact(): Promise<void>
  signOutAccount(): Promise<void>
  loadAccountDetails(): Promise<void>
  acknowledgeAccountBonus(orderId: string): Promise<boolean>
  openAccountPage(page: 'usage' | 'top-up'): Promise<void>
  initialize(): Promise<void>
  reconnect(): Promise<void>
  readDiagnostics(): Promise<DiagnosticsSnapshot | undefined>
  showDiagnostics(): Promise<void>
  refreshSessions(): Promise<void>
  searchSessions(query: string): Promise<SessionPage>
  refreshCommands(sessionId?: string): Promise<void>
  openSession(sessionId: string): Promise<void>
  openSkillDocument(sessionId: string, skillId: string): Promise<void>
  loadOlderHistory(): Promise<void>
  openSubagent(entry: SubagentView, parentAvailable: boolean): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>
  renameWorkspace(workspaceId: string, name: string): Promise<void>
  addWorkspaceFolder(): Promise<void>
  removeWorkspace(workspaceId: string): Promise<void>
  moveWorkspace(workspaceId: string, beforeWorkspaceId?: string): Promise<void>
  moveSession(workspaceId: string, sessionId: string, beforeSessionId?: string): Promise<void>
  forkSession(sessionId: string, atSeq?: number): Promise<void>
  createSession(workspaceId?: string, presetId?: string): Promise<void>
  stageSession(workspaceId?: string, presetId?: string): Promise<void>
  configurePendingSession(configuration: AgentConfiguration): void
  sendPendingPrompt(
    text: string,
    attachments: readonly PromptAttachment[],
    mode: RunningInputMode,
  ): Promise<void>
  removeSession(sessionId: string): Promise<void>
  /** Archived rows the host still holds, fetched with `session.list(archived: true)`. */
  loadArchivedSessions(): Promise<void>
  restoreSession(sessionId: string): Promise<void>
  /** Destructive: removes the conversation record from DSH. */
  deleteSession(sessionId: string): Promise<void>
  configureSession(sessionId: string, configuration: AgentConfiguration): Promise<void>
  executeCommand(
    sessionId: string,
    command: string,
    attachments?: readonly PromptAttachment[],
  ): Promise<boolean>
  sendPrompt(
    sessionId: string,
    text: string,
    attachments: readonly PromptAttachment[],
    mode: RunningInputMode,
  ): Promise<void>
  cancelSession(sessionId: string): Promise<void>
  followJob(jobId: string): Promise<void>
  stopFollowingJob(): Promise<void>
  killJob(jobId: string): Promise<'requested' | 'already-finished'>
  updateGoal(
    goalId: string,
    update: Partial<Pick<GoalView, 'title' | 'status' | 'maxGoalRounds'>>,
  ): Promise<void>
  clearGoal(goalId: string): Promise<void>
  updateQueue(inputId: string, text: string): Promise<void>
  removeQueue(inputId: string): Promise<void>
  steerQueue(inputId: string): Promise<void>
  /** Steer every still-queued pending input into the running turn (official empty-draft accelerated Enter). */
  steerAllQueued(): Promise<void>
  loadFeedback(sessionId: string): Promise<void>
  /** Ensure the active session's feedback catalog is seeded before deciding to retract. */
  ensureFeedback(sessionId: string, messageId: string): Promise<MessageFeedbackItem | undefined>
  toggleFeedback(sessionId: string, messageId: string, rating: MessageFeedbackRating): Promise<void>
  submitFeedback(
    sessionId: string,
    messageId: string,
    rating: MessageFeedbackRating,
    note?: string,
    category?: FeedbackCategory,
  ): Promise<void>
  setFeedbackNote(sessionId: string, messageId: string, note: string | undefined): Promise<void>
  removeFeedback(sessionId: string, messageId: string): Promise<void>
  listReferences(sessionId: string, query: string, quoted: boolean): Promise<readonly ReferenceCandidate[]>
  respondToPermission(interactionId: string, optionId: string): Promise<void>
  respondToQuestion(
    questionId: string,
    response: string | readonly string[] | readonly QuestionAnswer[],
  ): Promise<void>
  cancelQuestion(questionId: string): Promise<void>
  pickAttachment(): Promise<PromptAttachment | undefined>
  ingestAttachment(input: IngestedFile): Promise<PromptAttachment | undefined>
  previewAttachment(uri: string): Promise<string | undefined>
  readSessionAttachment(sessionId: string, image: MessageImageReference): Promise<string | undefined>
  releaseAttachments(uris: readonly string[]): Promise<void>
  captureEditorContext(kind: EditorContextKind, workspaceFolderId?: string): Promise<void>
  refreshEditorContext(workspaceFolderId?: string): Promise<void>
  previewEditorContext(contextRef: string): Promise<EditorContextPreview | undefined>
  releaseEditorContext(contextRefs: readonly string[]): Promise<void>
  refreshChanges(sessionId?: string): Promise<void>
  getChangeDetail(changeId: string): Promise<ChangeDetail | undefined>
  markChangeReviewed(changeId: string, reviewState: ChangeReviewState): Promise<ChangeSetFile | undefined>
  openChange(changeId: string): Promise<void>
  refreshTasks(sessionId?: string, includeCompleted?: boolean, scope?: TaskListScope): Promise<void>
  getTask(taskId: string): Promise<TaskSummary | undefined>
  stopTask(taskId: string, taskRevision: number): Promise<TaskSummary | undefined>
  answerTask(taskId: string, interactionId: string, answer: string): Promise<TaskSummary | undefined>
  refreshCheckpoints(sessionId?: string): Promise<void>
  createCheckpoint(label?: string): Promise<CheckpointSummary | undefined>
  previewCheckpoint(checkpointId: string): Promise<CheckpointPreview | undefined>
  deleteCheckpoint(checkpointId: string): Promise<void>
  restoreCheckpoint(
    checkpointId: string,
    previewId: string,
    conflictPolicy: CheckpointConflictPolicy,
  ): Promise<'completed' | 'partial' | undefined>
  refreshPromptTemplates(sessionId?: string, scope?: PromptTemplateScope): Promise<void>
  readPromptTemplate(templateId: string): Promise<PromptTemplate | undefined>
  insertPromptTemplate(
    templateId: string,
    variables?: Readonly<Record<string, string>>,
  ): Promise<PromptTemplateInsertion | undefined>
  createPromptTemplate(draft: PromptTemplateDraft): Promise<PromptTemplateSummary | undefined>
  updatePromptTemplate(
    templateId: string,
    patch: PromptTemplateUpdate,
  ): Promise<PromptTemplateSummary | undefined>
  deletePromptTemplate(templateId: string): Promise<void>
  setPromptMode(mode: PromptMode): Promise<boolean>
  listOpenFiles(): Promise<readonly OpenFileCandidate[]>
  attachOpenFile(candidateId: string): Promise<PromptAttachment | undefined>
  rememberOpenFile(candidateId: string): void
  openLink(href: string): Promise<void>
  showInFolder(href: string): Promise<void>
  runtimeAction(action: 'install' | 'select' | 'copy-command' | 'open-docs'): Promise<void>
  configureConnection(mode: 'auto' | 'custom', endpoint?: string): Promise<void>
  checkDshUpdates(force?: boolean): Promise<DshUpdateSnapshot | undefined>
  installDshVersion(version: string): Promise<DshUpdateSnapshot | undefined>
  readSettings(): Promise<ExtensionSettingsSummary | undefined>
  readDshSettings(): Promise<DshSettingsSnapshot | undefined>
  openDshSettingsDocument(): Promise<void>
  openKeyboardShortcuts(): Promise<void>
  updateDshSetting(path: string, value: unknown, expectedRevision: number): Promise<void>
  unsetDshSetting(path: string, expectedRevision: number): Promise<void>
  mutateDshSettings(
    namespace: string,
    operations: readonly SettingsPathOperation[],
    expectedRevision: number,
  ): Promise<void>
  createCustomProvider(draft: CustomProviderDraft): Promise<CustomProviderCreateResult>
  configureProviderSecret(providerId: string, field: string): Promise<boolean>
  removeProviderSecret(providerId: string, field: string): Promise<void>
  /** Configure a plugin-owned credential without carrying the secret in the Webview. */
  configurePluginCredential(ref: string): Promise<boolean>
  removePluginCredential(ref: string): Promise<void>
  refreshModelCatalog(): Promise<void>
  /**
   * Re-read the active session's model directory. A refused read keeps the last
   * good directory and publishes the host's reason; this is the seat's retry.
   */
  refreshSessionModels(sessionId?: string): Promise<void>
  /** Discover provider models through the Host without carrying credentials in the Webview. */
  discoverModels(input: Omit<ModelDiscoveryInput, 'apiKey'>): Promise<readonly DiscoveredModel[]>
  /** Discover models for a new provider through a Host-only optional key prompt. */
  discoverCustomProviderModels(
    input: Omit<ModelDiscoveryInput, 'apiKey'>,
  ): Promise<readonly DiscoveredModel[]>
  /** Read the preset roster with the adapter's management and display capabilities. */
  loadPresetRoster(): Promise<AgentPresetRoster | undefined>
  /** Open one shipped preset's composition in the read-only viewer. */
  readPresetDocument(presetId: string): Promise<AgentPresetDocument | undefined>
  /** Copy one preset host-side; resolves to the created preset id. */
  copyPreset(from: string, presetId: string, name?: string): Promise<string | undefined>
  /** Delete a user preset; running sessions keep their mounted composition. */
  removePreset(presetId: string): Promise<void>
  /** Open a preset directory natively, or reveal its path. */
  openPresetDocument(presetId: string): Promise<AgentPresetLocation | undefined>
  /** Read the host's read-only plugin inventory; no mutation path exists. */
  loadPluginInventory(): Promise<PluginInventorySnapshot | undefined>
  /** Install once, retaining the same DSH request id when its reply is uncertain. */
  startPluginInstall(input: PluginInstallInput): Promise<void>
  /** Make one request-scoped cancellation attempt for the active install. */
  cancelPluginInstall(): Promise<void>
  /** Recover the active install result using its original request id. */
  recoverPluginInstall(): Promise<void>
  /** Lazily load one parent's subagent catalog level (`subagent.list`). */
  loadSubagentChildren(sessionId: string): Promise<SubagentCatalog | undefined>
  /** Run the host-mediated save flow for one session (`session.export`). */
  exportSession(options: SessionExportOptions): Promise<void>
  setDrawer(drawer: AppState['drawer']): void
}

export interface AppStore extends AppState, AppActions {
  getState(): AppState
  subscribe(listener: () => void): () => void
  /** Wait for a structured turn end after observing its start in this Session. */
  watchSessionTurnEnd(sessionId: string): { readonly completion: Promise<void>; dispose(): void }
  dispose(): void
}

export interface ActiveSubagent {
  readonly entry: SubagentView
  readonly parentAvailable: boolean
  readonly workspaceId: string
}

export type StateSetter = (next: AppState | ((current: AppState) => AppState)) => void

export type LiveHistoryAppender = (sessionId: string, entry: SessionHistoryEvent) => void
