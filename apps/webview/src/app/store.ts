import { isPluginMetadata } from '@dsh-vscode/domain'
import {
  parseSlashCommand,
  FEATURE_CAPABILITY_IDS,
  type AgentConfiguration,
  type AgentPresetDescriptor,
  type AgentPresetDocument,
  type AgentPresetLocation,
  type AgentPresetRoster,
  type BackendEvent,
  type ChangeDetail,
  type ChangeReviewState,
  type ChangeSetFile,
  type CheckpointConflictPolicy,
  type CheckpointPreview,
  type CheckpointSummary,
  type CustomProviderCreateResult,
  type CustomProviderDraft,
  type DshSettingsSchema,
  type DshRuntimeUpdateProgress,
  type DshUpdateSnapshot,
  type DiagnosticsSnapshot,
  type DiscoveredModel,
  type DynamicCommand,
  type EditorContextItem,
  type EditorContextKind,
  type EditorContextPreview,
  type FeatureEventIdentity,
  type FeatureCapabilityProfile,
  isCanonicalWorkspaceRelativePath,
  isValidEditorContextRange,
  type ExtensionSettingsSummary,
  type GoalView,
  type FeedbackCategory,
  type JobFollowFrame,
  type JobOutputChunk,
  type JobView,
  type MessageFeedbackItem,
  type MessageFeedbackRating,
  type MessageAttachment,
  type MessageImageReference,
  type ModelCatalogFailure,
  type ModelDescriptor,
  type ModelDiscoveryInput,
  type ModelProvider,
  type ModelReasoningLevel,
  type ModelSelection,
  type PermissionRequest,
  type PermissionOption,
  type PluginInventorySnapshot,
  type PresentedFileView,
  type PromptTemplate,
  type PromptTemplateDraft,
  type PromptTemplateInsertion,
  type PromptMode,
  type PromptTemplateScope,
  type PromptTemplateSummary,
  type PromptTemplateUpdate,
  type PromptTemplateVariable,
  isPromptMode,
  isPromptTemplateVariable,
  resolvePromptMode,
  type PromptAttachment,
  type QuestionAnswer,
  type QuestionChoice,
  type QuestionIntent,
  type QueuedInput,
  type RunningInputMode,
  type SessionConfigurationPatch,
  type SessionExportOptions,
  type SessionHistoryEvent,
  type SessionSequenceRange,
  type SessionProjectionSnapshot,
  type SessionSummary,
  type SkillDescriptor,
  type TeamActivityView,
  type TaskListScope,
  type TaskSummary,
  type TurnEndFailure,
  type SubagentCatalog,
  type SubagentCatalogEntryFact,
  type SubagentHistoryPage,
  type SubagentView,
  type TokenUsage,
  type TodoView,
  type ToolPresentationDiff,
  type ToolPresentationLine,
  type ToolPresentationSearchFile,
  type ToolPresentationSearchMatch,
  type ToolPresentationSource,
  type ToolPresentationView,
  type TurnEndReasonKind,
  type UserQuestion,
  type UserQuestionItem,
  type WorkflowMember,
  type WorkflowSummary,
  type WorkspaceSummary,
} from '@dsh-vscode/domain'
import {
  isInjectedUserMessage,
  reduceTimeline,
  reduceTimelineBatch,
  type TimelineNode,
  type TimelineState,
} from '@dsh-vscode/timeline'
import { diagnosticsSnapshotSchema, featureResponseSchema } from '@dsh-vscode/webview-protocol'
import type { FeatureResponse, HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'

import { translate } from '../i18n.js'
import { ProtocolClient } from './protocol-client.js'
import { getVsCodeApi } from '../vscode-api.js'

const STORE_NOTIFY_BATCH_MS = 16

// A transient session.open failure (request timeout, BACKEND_UNREACHABLE while
// the backend is still settling) leaves the panel without any conversation at
// all. Retry the open request a bounded number of times with a short backoff;
// the host marks definitive rejections with retryable: false and those surface
// to the error banner immediately.
const OPEN_RETRY_ATTEMPTS = 3
const OPEN_RETRY_BASE_DELAY_MS = 300

const isRetryableOpenFailure = (reason: unknown): boolean =>
  reason instanceof Error && (reason as { retryable?: unknown }).retryable === true

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
  /** Safe connected-host version copied from the Extension Host snapshot. */
  readonly connectedDshVersion: string | undefined
  /** True only when the selected pinned adapter accepts inline subagent images. */
  readonly subagentImagePrompts: boolean
  readonly sessionRestore?: boolean
  readonly jobControllerAvailable: boolean
  /** Safe compatibility warning for an unknown/fallback DSH runtime. */
  readonly dshCompatibilityWarning: string | undefined
  /** Host-projected feature readiness; no endpoint or credential data. */
  readonly featureProfile: FeatureCapabilityProfile | undefined
  /** Latest Host-owned npm registry snapshot for the DSH runtime. */
  readonly dshUpdate: DshUpdateSnapshot | undefined
  /** Latest phase emitted by the Host while an update request is running. */
  readonly dshUpdateProgress: DshRuntimeUpdateProgress | undefined
  readonly sessions: readonly SessionSummary[]
  readonly archivedSessionIds: readonly string[]
  /** Rows the host still holds after archiving; loaded on demand. */
  readonly archivedSessions: readonly SessionSummary[]
  readonly workspaces: readonly WorkspaceSummary[]
  readonly activeSessionId: string | undefined
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
   * Whether the host serves the session's current selection at all, as the
   * directory states it. `undefined` means no directory has answered yet,
   * which is not the same as unroutable; the host refuses a prompt it cannot
   * route either way, so this only decides whether the input stays usable.
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
  readonly drawer: 'sessions' | 'jobs' | 'subagents' | 'settings' | undefined
}

/** Schema-driven DSH host settings snapshot (describe + resolved values). */
export interface DshSettingsSnapshot {
  readonly schema: DshSettingsSchema
  readonly values: Readonly<Record<string, unknown>>
}

export interface JobFollowState {
  readonly jobId: string
  readonly next: number
  readonly chunks: readonly JobOutputChunk[]
  readonly lossy: boolean
  /** Local request identity used to ignore an older start failure. */
  readonly generation?: number
  /** The matching `opened(from)` frame must arrive before this follow is live. */
  readonly awaitingOpenFrom?: number
  readonly job?: JobView
  /** An opened row may already be settled; only a terminal status frame closes output delivery. */
  readonly terminalStatusReceived?: boolean
}

export interface AppActions {
  initialize(): Promise<void>
  reconnect(): Promise<void>
  readDiagnostics(): Promise<DiagnosticsSnapshot | undefined>
  showDiagnostics(): Promise<void>
  refreshSessions(): Promise<void>
  searchSessions(query: string): Promise<readonly SessionSummary[]>
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
  updateDshSetting(path: string, value: unknown): Promise<void>
  unsetDshSetting(path: string): Promise<void>
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
  /** Read the full preset roster with its authorable/hasDocument facts. */
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
  /** Lazily load one parent's subagent catalog level (`subagent.list`). */
  loadSubagentChildren(sessionId: string): Promise<SubagentCatalog | undefined>
  /** Run the host-mediated save flow for one session (`session.export`). */
  exportSession(options: SessionExportOptions): Promise<void>
  setDrawer(drawer: AppState['drawer']): void
}

export interface AppStore extends AppState, AppActions {
  getState(): AppState
  subscribe(listener: () => void): () => void
  dispose(): void
}

type StateSetter = (next: AppState | ((current: AppState) => AppState)) => void
type LiveHistoryAppender = (sessionId: string, entry: SessionHistoryEvent) => void
interface ProjectionSequenceIndex {
  readonly perKey: Map<string, Map<string, number>>
  readonly baselines: Map<string, number>
}

interface PendingSessionOpen {
  readonly version: number
  readonly sessionId: string
  /** Lossless until the authoritative open/advisory replay has committed. */
  readonly messages: HostMessage[]
  readonly messageKeys: Set<string>
  replayedMessages: number
  ready: boolean
}

interface ComposerPreferences {
  readonly preset?: string
  readonly model?: ModelSelection
  readonly openFileId?: string
  readonly promptMode?: PromptMode
}

interface PersistedWebviewState {
  readonly version: 1
  readonly composerPreferences?: ComposerPreferences
  readonly activeSessionId?: string
}

export interface ActiveSubagent {
  readonly entry: SubagentView
  readonly parentAvailable: boolean
  readonly workspaceId: string
}

const EMPTY_SUBAGENT_CATALOG: SubagentCatalog = { entries: [], parentAvailable: false }
const DSH_RC11_VERSION = '0.1.1-rc.1'
const DSH_RC12_VERSION = '0.1.1-rc.2'

export function createAppStore(client = new ProtocolClient(getVsCodeApi())): AppStore {
  const vscodeApi = getVsCodeApi()
  let persistedWebviewState = readPersistedWebviewState(vscodeApi.getState())
  let composerPreferences = persistedWebviewState.composerPreferences ?? {}
  let state: AppState = {
    backend: { kind: 'idle' },
    connectedDshVersion: undefined,
    subagentImagePrompts: false,
    sessionRestore: false,
    jobControllerAvailable: false,
    dshCompatibilityWarning: undefined,
    featureProfile: undefined,
    dshUpdate: undefined,
    dshUpdateProgress: undefined,
    sessions: [],
    archivedSessionIds: [],
    archivedSessions: [],
    workspaces: [],
    activeSessionId: undefined,
    preferredOpenFileId: composerPreferences.openFileId,
    timeline: { sessionId: undefined, nodes: [], lastSequence: -1, nodeChangeStart: 0, eventCount: 0 },
    history: [],
    historyHasMore: false,
    historyBeforeSequence: undefined,
    historyLoading: false,
    projections: {},
    configuration: undefined,
    providers: [],
    models: [],
    sessionModels: [],
    sessionModelFailures: [],
    sessionModelCurrent: undefined,
    sessionModelRoutable: undefined,
    sessionModelDirectoryLoading: false,
    sessionModelDirectoryError: undefined,
    presets: [],
    presetSelectionEnabled: undefined,
    permissionPresets: [],
    commands: [],
    pluginInventoryRevision: 0,
    goals: [],
    todos: [],
    jobs: [],
    jobFollow: undefined,
    feedback: {},
    feedbackUnavailable: false,
    subagents: EMPTY_SUBAGENT_CATALOG,
    activeSubagent: undefined,
    queue: [],
    editorContext: [],
    editorContextAvailableKinds: [],
    editorContextLoading: false,
    changes: [],
    changesRefreshFailed: false,
    changesLoading: false,
    tasks: [],
    tasksLoading: false,
    taskScope: 'current-session',
    tasksComplete: true,
    tasksOmittedSessions: 0,
    checkpoints: [],
    unavailableLists: [],
    checkpointsLoading: false,
    promptTemplates: [],
    promptTemplatesLoading: false,
    promptMode: composerPreferences.promptMode ?? 'ask',
    permissions: [],
    questions: [],
    busyEnter: 'queue',
    drawer: undefined,
  }
  // Projection values arrive from both the Alpha Session/follow stream and
  // the independent session/control stream. Keep their DSH cut outside the
  // public state so an older snapshot cannot overwrite a newer live value.
  const projectionSequences: ProjectionSequenceIndex = {
    perKey: new Map(),
    baselines: new Map(),
  }
  const listeners = new Set<() => void>()
  let notifyTimer: number | undefined
  let pendingHistorySessionId: string | undefined
  let pendingHistory: SessionHistoryEvent[] = []
  // Feedback is an advisory first-paint read, but a mutation must never race
  // that read with an empty CAS cache. Share the in-flight request and remember
  // successful seeds so a cold row can wait for the same authoritative catalog
  // without issuing a second list call.
  const feedbackLoads = new Map<string, Promise<FeedbackListResult>>()
  const feedbackReadySessions = new Set<string>()
  let feedbackGeneration = 0
  const invalidateFeedback = (): void => {
    feedbackGeneration += 1
    feedbackLoads.clear()
    feedbackReadySessions.clear()
  }
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  const flushPendingHistory = (): void => {
    if (pendingHistory.length === 0) return
    const sessionId = pendingHistorySessionId
    const additions = pendingHistory
    pendingHistory = []
    pendingHistorySessionId = undefined
    if (sessionId === undefined || state.activeSessionId !== sessionId) return
    const history = mergeHistory(state.history, additions)
    if (history !== state.history) state = { ...state, history }
  }
  let jobFollowGeneration = 0
  const scheduleNotify = (): void => {
    if (notifyTimer !== undefined) return
    notifyTimer = window.setTimeout(() => {
      notifyTimer = undefined
      flushPendingHistory()
      notify()
    }, STORE_NOTIFY_BATCH_MS)
  }
  const appendLiveHistory: LiveHistoryAppender = (sessionId, entry): void => {
    if (pendingHistorySessionId !== undefined && pendingHistorySessionId !== sessionId) flushPendingHistory()
    pendingHistorySessionId = sessionId
    pendingHistory.push(entry)
    // History-only events (for example an unchanged projection) can leave
    // applyHostMessage with the same AppState object. They still need the
    // normal frame notification so the history ledger is published without a
    // later session switch or unrelated state update.
    scheduleNotify()
  }
  const setState: StateSetter = (next): void => {
    const nextState = typeof next === 'function' ? next(state) : next
    if (nextState === state) {
      // A guarded async refresh can legitimately produce the current object.
      // Do not wake React for that no-op, but keep the coalesced history
      // flush alive when a live event was appended before the guard ran.
      if (pendingHistory.length > 0) scheduleNotify()
      return
    }
    state = nextState
    // Host streams can deliver hundreds of deltas for one answer. State is
    // still reduced synchronously so ordering and reads stay authoritative;
    // only the React subscriber notification is coalesced to one frame.
    scheduleNotify()
  }
  // Sequence holes reach the store as `session.gap` events. The timeline gate
  // drops anything at or below its cursor, so a healed hole can only become
  // visible through a rebuild from the history ledger, and anything history
  // itself is missing has to be refetched through session.history pages.
  const gapBackfills = new Map<
    string,
    { ranges: Array<{ readonly from: number; readonly to: number }>; running: boolean }
  >()
  /**
   * Gap warnings are host-only rows: a rebuild from the durable ledger
   * reconstructs the transcript and would silently drop the warning that part
   * of it never arrived. Keep the announced ranges so every rebuild can
   * re-derive the notice from what history still cannot cover.
   */
  const unhealedGapRanges = new Map<string, readonly SessionSequenceRange[]>()
  /**
   * Raw page coverage per session. A page's presentation rows may legitimately
   * omit sequences (hidden system rows, deltas compacted into one row), so the
   * ledger alone cannot prove an announced hole was read. Remember what each
   * successful page vouched for, otherwise a warning published after a failed
   * attempt outlives the hole it describes.
   */
  const coveredHistoryRanges = new Map<string, readonly SessionSequenceRange[]>()
  let ledgerRebuildTimer: number | undefined
  const MAX_GAP_BACKFILL_PAGES = 4
  const GAP_BACKFILL_PAGE_MESSAGES = 200
  const MAX_COVERED_HISTORY_SESSIONS = 32
  const gapNoticeId = (sessionId: string, fromSequence: number, toSequence: number): string =>
    `gap:${sessionId}:${fromSequence}:${toSequence}`
  const rememberCoveredRanges = (sessionId: string, ranges: readonly SessionSequenceRange[]): void => {
    if (ranges.length === 0) return
    const merged = mergeSequenceRanges(coveredHistoryRanges.get(sessionId) ?? [], ranges)
    // Re-insert so the least recently read session is evicted first.
    coveredHistoryRanges.delete(sessionId)
    coveredHistoryRanges.set(sessionId, merged)
    while (coveredHistoryRanges.size > MAX_COVERED_HISTORY_SESSIONS) {
      const oldest = coveredHistoryRanges.keys().next().value
      if (oldest === undefined) break
      coveredHistoryRanges.delete(oldest)
    }
  }
  const historyCoversAnnouncedRange = (
    sessionId: string,
    history: readonly SessionHistoryEvent[],
    fromSequence: number,
    toSequence: number,
  ): boolean =>
    historyCoversSequenceRange(history, fromSequence, toSequence) ||
    sequenceRangesCover(coveredHistoryRanges.get(sessionId) ?? [], fromSequence, toSequence)
  /**
   * Reconcile the session's warning rows with the announced ranges: one row per
   * merged range, so an adjacent re-announcement refreshes the existing warning
   * instead of adding a second one for the same contiguous hole.
   */
  const syncGapNotices = (timeline: TimelineState, sessionId: string): TimelineState => {
    const announced = unhealedGapRanges.get(sessionId) ?? []
    const prefix = `gap:${sessionId}:`
    const wanted = new Set(announced.map((range) => gapNoticeId(sessionId, range.from, range.to)))
    const kept = timeline.nodes.filter((node) => !node.id.startsWith(prefix) || wanted.has(node.id))
    let next = kept.length === timeline.nodes.length ? timeline : { ...timeline, nodes: kept }
    for (const range of announced) {
      const id = gapNoticeId(sessionId, range.from, range.to)
      if (next.nodes.some((node) => node.id === id)) continue
      next = reduceTimeline(next, {
        sequence: next.lastSequence,
        event: { type: 'session.gap', sessionId, fromSequence: range.from, toSequence: range.to },
        advanceSequence: false,
      })
    }
    return next
  }
  const publishUnhealedGap = (sessionId: string, fromSequence: number, toSequence: number): void => {
    if (historyCoversAnnouncedRange(sessionId, [], fromSequence, toSequence)) return
    const announced = unhealedGapRanges.get(sessionId) ?? []
    unhealedGapRanges.set(sessionId, mergeSequenceRanges(announced, [{ from: fromSequence, to: toSequence }]))
    setState((current) => {
      if (current.activeSessionId !== sessionId) return current
      const timeline = syncGapNotices(current.timeline, sessionId)
      return timeline === current.timeline ? current : { ...current, timeline }
    })
  }
  const restoreGapNotices = (
    rebuilt: TimelineState,
    sessionId: string,
    history: readonly SessionHistoryEvent[],
  ): TimelineState => {
    const announced = unhealedGapRanges.get(sessionId)
    if (announced !== undefined) {
      const remaining = announced.filter(
        (range) => !historyCoversAnnouncedRange(sessionId, history, range.from, range.to),
      )
      if (remaining.length === 0) unhealedGapRanges.delete(sessionId)
      else if (remaining.length !== announced.length) unhealedGapRanges.set(sessionId, remaining)
    }
    return syncGapNotices(rebuilt, sessionId)
  }
  /**
   * Command notices and agent errors are host-only rows: DSH never replays
   * them, so every path that rebuilds the transcript - a below-cursor rebuild,
   * a switch back to the session - would silently erase them from the
   * conversation. Remember them per session together with the rows they
   * arrived behind, and put them back at that position.
   */
  const rememberedHostOnlyNodes = new Map<
    string,
    Array<{ readonly node: TimelineNode; readonly anchors: readonly string[] }>
  >()
  const MAX_HOST_ONLY_NODES_PER_SESSION = 128
  const MAX_HOST_ONLY_SESSIONS = 16
  const rememberHostOnlyNodes = (
    sessionId: string,
    nodes: readonly TimelineNode[],
    anchors: readonly string[],
  ): void => {
    const remembered = rememberedHostOnlyNodes.get(sessionId) ?? []
    const next = [...remembered]
    for (const node of nodes)
      if (!next.some((entry) => entry.node.id === node.id)) next.push({ node, anchors })
    while (next.length > MAX_HOST_ONLY_NODES_PER_SESSION) next.shift()
    // Re-insert so the least recently active session is evicted first.
    rememberedHostOnlyNodes.delete(sessionId)
    rememberedHostOnlyNodes.set(sessionId, next)
    while (rememberedHostOnlyNodes.size > MAX_HOST_ONLY_SESSIONS) {
      const oldest = rememberedHostOnlyNodes.keys().next().value
      if (oldest === undefined) break
      rememberedHostOnlyNodes.delete(oldest)
    }
  }
  const restoreHostOnlyNodes = (timeline: TimelineState, sessionId: string): TimelineState => {
    const remembered = rememberedHostOnlyNodes.get(sessionId)
    if (remembered === undefined || remembered.length === 0) return timeline
    let nodes: TimelineNode[] | undefined
    // Arrival order is the invariant: rows that arrived later can never end up
    // in front of a row that arrived earlier, whatever their anchors resolve
    // to (rows that arrived before any durable node have no anchor at all).
    let previousIndex = -1
    for (const entry of remembered) {
      const existing = (nodes ?? timeline.nodes).findIndex((node) => node.id === entry.node.id)
      if (existing >= 0) {
        previousIndex = existing
        continue
      }
      const target = nodes ?? (nodes = [...timeline.nodes])
      const index = Math.max(hostOnlyInsertIndex(target, entry.anchors), previousIndex + 1)
      target.splice(index, 0, entry.node)
      previousIndex = index
    }
    return nodes === undefined
      ? timeline
      : { ...timeline, nodes, nodeChangeBase: timeline.nodes, nodeChangeStart: 0 }
  }
  const rebuildTimelineFromLedger = (sessionId: string): void => {
    flushPendingHistory()
    setState((current) => {
      if (current.activeSessionId !== sessionId) return current
      const rebuilt = hydrateTimelineFromHistoryEvents(sessionId, current.history)
      return {
        ...current,
        timeline: mergeLiveTransientNodes(
          restoreHostOnlyNodes(restoreGapNotices(rebuilt, sessionId, current.history), sessionId),
          current.timeline,
          current.history,
        ),
      }
    })
  }
  const scheduleLedgerRebuild = (sessionId: string): void => {
    // Out-of-order live frames (recovery, re-snapshot
    // redelivery) land in the ledger but are dropped by the timeline cursor.
    // One coalesced rebuild republishes the ledger; a newer open() rebuilds
    // its own baseline anyway, so a stale rebuild just bows out.
    const version = openVersion
    if (ledgerRebuildTimer !== undefined) clearTimeout(ledgerRebuildTimer)
    ledgerRebuildTimer = window.setTimeout(() => {
      ledgerRebuildTimer = undefined
      if (openVersion !== version) return
      rebuildTimelineFromLedger(sessionId)
    }, STORE_NOTIFY_BATCH_MS)
  }
  const runGapBackfill = async (
    sessionId: string,
    entry: { ranges: Array<{ readonly from: number; readonly to: number }>; running: boolean },
  ): Promise<void> => {
    const version = openVersion
    try {
      while (entry.ranges.length > 0) {
        if (disposed) return
        const range = entry.ranges.shift()
        if (range === undefined) break
        let beforeSeq = range.to + 1
        // Pages answered after another open superseded this one can no longer
        // be merged into the session's ledger, so the read stops fetching.
        // Stopping must not lose the announcement: the range is still recorded
        // below and the notice is re-derived from the session's own history
        // the next time it is shown.
        for (let page = 0; page < MAX_GAP_BACKFILL_PAGES; page += 1) {
          if (version !== openVersion) break
          let payload: unknown
          try {
            payload = await client.request<unknown>({
              type: 'session.history',
              requestId: requestId(),
              payload: { sessionId, beforeSeq, maxMessages: GAP_BACKFILL_PAGE_MESSAGES },
            })
          } catch {
            break
          }
          let events: readonly SessionHistoryEvent[]
          let hasMore = false
          let nextBefore: number | undefined
          try {
            const parsed = parseSessionHistoryPage(payload)
            events = parsed.events
            hasMore = parsed.hasMore
            nextBefore = parsed.beforeSequence ?? oldestHistorySequence(parsed.events)
            rememberCoveredRanges(
              sessionId,
              parsed.coveredSequenceRanges ?? historySequenceRanges(parsed.events),
            )
          } catch {
            break
          }
          if (version !== openVersion) break
          if (events.length === 0) break
          setState((current) =>
            current.activeSessionId === sessionId
              ? { ...current, history: mergeHistory(current.history, events) }
              : current,
          )
          rebuildTimelineFromLedger(sessionId)
          const oldest = oldestHistorySequence(events)
          if (!hasMore || oldest === undefined || oldest <= range.from) break
          if (nextBefore === undefined || nextBefore <= 0) break
          beforeSeq = nextBefore
        }
        // The range memory is per session, so an unhealed hole is recorded even
        // while another session is on screen; the notice itself is re-derived
        // when that session is opened again. Only this session's own history and
        // page windows can vouch for the hole: sequence numbers of another
        // session's history say nothing about it.
        if (
          !disposed &&
          !historyCoversAnnouncedRange(
            sessionId,
            state.activeSessionId === sessionId ? state.history : [],
            range.from,
            range.to,
          )
        )
          publishUnhealedGap(sessionId, range.from, range.to)
      }
    } finally {
      entry.running = false
      if (entry.ranges.length === 0) gapBackfills.delete(sessionId)
    }
  }
  const scheduleGapBackfill = (event: Extract<BackendEvent, { type: 'session.gap' }>): void => {
    const sessionId = event.sessionId
    const entry = gapBackfills.get(sessionId) ?? { ranges: [], running: false }
    // Merge overlapping/adjacent announcements so a re-announced hole cannot
    // multiply identical page fetches; the merged range still re-fetches once
    // when a previous attempt failed, which keeps the heal self-retrying.
    let from = event.fromSequence
    let to = event.toSequence
    const unmerged: Array<{ readonly from: number; readonly to: number }> = []
    for (const range of entry.ranges) {
      if (range.from <= to + 1 && range.to + 1 >= from) {
        from = Math.min(from, range.from)
        to = Math.max(to, range.to)
      } else unmerged.push(range)
    }
    entry.ranges = [...unmerged, { from, to }]
    gapBackfills.set(sessionId, entry)
    if (entry.running) return
    entry.running = true
    void runGapBackfill(sessionId, entry)
  }
  const persistWebviewState = (overrides: { readonly activeSessionId?: string } = {}): void => {
    const activeSessionId = overrides.activeSessionId ?? state.activeSessionId
    persistedWebviewState =
      activeSessionId === undefined
        ? { version: 1, composerPreferences }
        : { version: 1, composerPreferences, activeSessionId }
    vscodeApi.setState(persistedWebviewState)
  }
  const rememberComposerConfiguration = (configuration: AgentConfiguration): void => {
    const preset = configuration.preset.trim()
    const model = normalizedModelSelection(configuration.model)
    const rememberedPreset = preset === '' ? composerPreferences.preset : preset
    const rememberedModel = model ?? composerPreferences.model
    composerPreferences = {
      ...composerPreferences,
      ...(rememberedPreset === undefined ? {} : { preset: rememberedPreset }),
      ...(rememberedModel === undefined ? {} : { model: rememberedModel }),
    }
    persistWebviewState()
  }
  const callbacks: { openCreatedSession?: (sessionId: string) => Promise<void> } = {}
  let refreshVersion = 0
  let goalActivationAvailable = false
  let goalReadGeneration = 0
  let permissionCatalogGeneration = 0
  let openVersion = 0
  const refreshLiveGoals = async (): Promise<void> => {
    const sessionId = state.activeSessionId
    if (sessionId === undefined || !goalActivationAvailable) return
    const generation = ++goalReadGeneration
    const version = openVersion
    try {
      const goals = parseGoalViews(
        await client.request<unknown>({ type: 'goal.list', requestId: requestId(), payload: { sessionId } }),
      )
      if (
        !disposed &&
        version === openVersion &&
        generation === goalReadGeneration &&
        state.activeSessionId === sessionId &&
        goals !== undefined
      )
        setState((current) => (sameGoalList(current.goals, goals) ? current : { ...current, goals }))
    } catch {
      /* Durable goal state remains available; the next live edge retries. */
    }
  }

  // Claims the "most recent view request" slot for opens that have to await a
  // catalog read before they can claim `openVersion`.
  let openIntent = 0
  let disposed = false
  // A newly-created store has not yet made its one automatic session choice.
  // Keep that decision pending when the first registry snapshot is empty: the
  // DSH workspace/session registries can publish in adjacent turns.
  let startupRestorePending = true
  let startupRestoreArmed = false
  let startupRestorePromise: Promise<void> | undefined
  let editorContextRefreshGeneration = 0
  let changesRefreshGeneration = 0
  let tasksRefreshGeneration = 0
  let checkpointsRefreshGeneration = 0
  let promptTemplatesRefreshGeneration = 0
  const pendingOpens = new Map<number, PendingSessionOpen>()
  const latestPendingOpen = new Map<string, PendingSessionOpen>()
  const deferredOpenMessages = new Map<string, HostMessage[]>()
  const deferredOpenMessageKeys = new Map<string, Set<string>>()
  const sameHostEvent = (left: HostMessage, right: HostMessage): boolean => {
    if (left.type !== 'event' || right.type !== 'event') return false
    if (left.sequence !== right.sequence) return false
    try {
      // Host sequence is the transport ordering key, not the durable DSH
      // identity. Keep two distinct events if a reconnect/replay ever reuses
      // one host slot; otherwise a valid projection/tool record can vanish
      // before the open barrier is released.
      return JSON.stringify(left) === JSON.stringify(right)
    } catch {
      return false
    }
  }
  const hostMessageIdentity = (message: HostMessage): string | undefined => {
    if (message.type !== 'event') return undefined
    try {
      return JSON.stringify(message)
    } catch {
      return undefined
    }
  }
  const hostMessageSequence = (message: HostMessage): number =>
    message.type === 'event' ? message.sequence : Number.MAX_SAFE_INTEGER
  const appendUniqueHostMessage = (
    messages: HostMessage[],
    messageKeys: Set<string>,
    message: HostMessage,
  ): void => {
    const identity = hostMessageIdentity(message)
    if (identity !== undefined) {
      if (messageKeys.has(identity)) return
      messageKeys.add(identity)
    } else if (messages.some((candidate) => sameHostEvent(candidate, message))) return
    messages.push(message)
  }
  const appendPendingMessage = (pending: PendingSessionOpen, message: HostMessage): void => {
    appendUniqueHostMessage(pending.messages, pending.messageKeys, message)
  }
  const appendDeferredMessage = (sessionId: string, message: HostMessage): void => {
    const messages = deferredOpenMessages.get(sessionId) ?? []
    const messageKeys = deferredOpenMessageKeys.get(sessionId) ?? new Set<string>()
    appendUniqueHostMessage(messages, messageKeys, message)
    deferredOpenMessages.set(sessionId, messages)
    deferredOpenMessageKeys.set(sessionId, messageKeys)
  }
  const createPendingOpen = (sessionId: string, version: number): PendingSessionOpen => {
    const pending: PendingSessionOpen = {
      version,
      sessionId,
      messages: [],
      messageKeys: new Set(),
      replayedMessages: 0,
      ready: false,
    }
    const deferred = deferredOpenMessages.get(sessionId)
    if (deferred !== undefined) {
      for (const message of deferred) appendPendingMessage(pending, message)
      deferredOpenMessages.delete(sessionId)
      deferredOpenMessageKeys.delete(sessionId)
    }
    const previous = latestPendingOpen.get(sessionId)
    if (previous !== undefined)
      for (const message of previous.messages) appendPendingMessage(pending, message)
    pending.messages.sort((left, right) => hostMessageSequence(left) - hostMessageSequence(right))
    pendingOpens.set(version, pending)
    latestPendingOpen.set(sessionId, pending)
    return pending
  }
  const settlePendingOpen = (pending: PendingSessionOpen, completed: boolean): void => {
    pendingOpens.delete(pending.version)
    const latest = latestPendingOpen.get(pending.sessionId)
    const ownsLatest = latest === pending
    const keepMessages = !completed || !ownsLatest || pending.version !== openVersion
    if (keepMessages) {
      if (latest !== undefined && latest !== pending) {
        for (const message of pending.messages) appendPendingMessage(latest, message)
      } else {
        for (const message of pending.messages) appendDeferredMessage(pending.sessionId, message)
      }
    }
    if (ownsLatest) latestPendingOpen.delete(pending.sessionId)
  }
  const pendingMessagesAfterReplay = (pending: PendingSessionOpen): readonly HostMessage[] => {
    const messages = pending.messages.slice(pending.replayedMessages)
    pending.replayedMessages = pending.messages.length
    return orderPendingReplayMessages(messages)
  }
  const pendingMessagesFrom = (pending: PendingSessionOpen, startIndex: number): readonly HostMessage[] => {
    // Durable records are cursor-gated and control records are idempotent,
    // but cursorless assistant frames deliberately bypass that gate. They
    // were already reduced during first paint/live delivery; replaying them
    // after an advisory snapshot would apply a stale prefix over a settled
    // assistant because the matching durable completion is now <= the cursor.
    const messages = pending.messages.slice(startIndex).filter(isAdvisoryReplayMessage)
    pending.replayedMessages = pending.messages.length
    return orderPendingReplayMessages(messages)
  }
  let commandDirectoryGeneration = 0
  let configurationGeneration = 0
  const commandDirectoryCache = new Map<string, readonly DynamicCommand[]>()
  const commandDirectoryLoads = new Map<string, Promise<readonly DynamicCommand[] | undefined>>()
  const loadCommandDirectory = (
    sessionId: string,
    force = false,
  ): Promise<readonly DynamicCommand[] | undefined> => {
    if (force) commandDirectoryCache.delete(sessionId)
    else {
      const cached = commandDirectoryCache.get(sessionId)
      if (cached !== undefined) return Promise.resolve(cached)
    }
    const pending = commandDirectoryLoads.get(sessionId)
    if (pending !== undefined) return pending
    const generation = commandDirectoryGeneration
    const load = readCommandList(client, sessionId)
      .then((commands) => {
        if (commands === undefined || generation !== commandDirectoryGeneration) return undefined
        commandDirectoryCache.set(sessionId, commands)
        return commands
      })
      .finally(() => {
        if (commandDirectoryLoads.get(sessionId) === load) commandDirectoryLoads.delete(sessionId)
      })
    commandDirectoryLoads.set(sessionId, load)
    return load
  }
  const refreshCommands = async (
    sessionId: string | undefined = state.activeSessionId,
    force = false,
  ): Promise<void> => {
    if (sessionId === undefined) return
    const commands = await loadCommandDirectory(sessionId, force)
    if (commands === undefined) return
    setState((current) =>
      current.activeSessionId === sessionId && current.commands !== commands
        ? { ...current, commands }
        : current,
    )
  }
  const loadSubagentCatalog = async (sessionId: string): Promise<SubagentCatalog | undefined> => {
    try {
      return parseSubagentCatalog(
        await client.request<unknown>({
          type: 'subagent.list',
          requestId: requestId(),
          payload: { sessionId },
        }),
      )
    } catch {
      // Catalog discovery is an optional header surface. Keep the conversation
      // usable on a transient read failure, but never adopt a partial answer.
      return undefined
    }
  }
  const refresh = async (): Promise<void> => {
    const version = ++refreshVersion
    // Session/workspace visibility is enough to choose the startup session.
    // Global providers, models, and presets are merged in the background so
    // their latency cannot delay opening the conversation.
    await refreshSessions(client, setState, () => version === refreshVersion, false)
    // The first session.list can legitimately be an empty projection while a
    // workspace attach is still being committed. Retry the automatic restore
    // after every authoritative refresh until a session has been opened.
    if (startupRestoreArmed) void attemptStartupRestore().catch(() => undefined)
    // The command directory is also advisory during startup. The session
    // opener starts the same deduplicated load for the active session, while
    // keeping slow command/skill providers off the first-paint critical path.
    if (version === refreshVersion) void refreshCommands().catch(() => undefined)
  }
  /**
   * The switcher's archived section is a recovery surface, so it is fetched
   * on demand instead of riding every refresh. A refused answer propagates:
   * an empty list would claim the host holds no archived sessions.
   */
  const loadArchivedSessions = async (): Promise<void> => {
    const result = await client.request<unknown>({
      type: 'session.list',
      requestId: requestId(),
      payload: { archived: true },
    })
    const sessions = strictListValues(object(result)?.items, isSessionSummary)
    if (sessions === undefined) return
    setState((current) =>
      sameSessionSummaryList(current.archivedSessions, sessions)
        ? current
        : { ...current, archivedSessions: sessions },
    )
  }
  const refreshEditorContextState = async (workspaceFolderId?: string): Promise<void> => {
    if (typeof client.featureRequest !== 'function') return
    const generation = ++editorContextRefreshGeneration
    setState((current) => ({ ...current, editorContextLoading: true }))
    try {
      const result = object(
        await client.featureRequest({
          type: 'editor.context.list',
          requestId: requestId(),
          payload: workspaceFolderId === undefined ? {} : { workspaceFolderId },
        }),
      )
      const items = result?.kind === 'editor.context' ? parseEditorContextItems(result.items) : undefined
      const availableKinds =
        result?.kind === 'editor.context'
          ? parseEditorContextAvailableKinds(result.availableKinds)
          : undefined
      if (
        items !== undefined &&
        availableKinds !== undefined &&
        generation === editorContextRefreshGeneration
      )
        setState((current) => ({
          ...current,
          editorContext: items,
          editorContextAvailableKinds: availableKinds,
        }))
    } finally {
      if (generation === editorContextRefreshGeneration)
        setState((current) => ({ ...current, editorContextLoading: false }))
    }
  }
  const refreshChangesState = async (
    sessionId: string | undefined = state.activeSessionId,
  ): Promise<void> => {
    if (typeof client.featureRequest !== 'function' || sessionId === undefined) return
    // No folder is open for this session, so there is no workspace scope to
    // read. Report it as nothing to show rather than as a failed refresh.
    const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
    if (workspaceFolderId === undefined) {
      setState((current) =>
        current.activeSessionId === sessionId ? { ...current, changesRefreshFailed: false } : current,
      )
      return
    }
    const generation = ++changesRefreshGeneration
    setState((current) => ({ ...current, changesLoading: true }))
    try {
      const result = await client.featureRequest({
        type: 'changes.list',
        requestId: requestId(),
        payload: { sessionId, workspaceFolderId, limit: 200 },
      })
      const changes = parseFeatureChangesResult(result)
      if (changes !== undefined)
        setState((current) =>
          generation === changesRefreshGeneration && current.activeSessionId === sessionId
            ? {
                ...current,
                changes,
                changesRefreshFailed: (result as { refreshFailed?: boolean }).refreshFailed === true,
              }
            : current,
        )
      else throw new Error('Invalid Changes response')
    } catch {
      setState((current) =>
        generation === changesRefreshGeneration && current.activeSessionId === sessionId
          ? { ...current, changesRefreshFailed: true }
          : current,
      )
    } finally {
      if (generation === changesRefreshGeneration)
        setState((current) => ({ ...current, changesLoading: false }))
    }
  }
  const refreshTasksState = async (
    sessionId: string | undefined = state.activeSessionId,
    includeCompleted = false,
    scope: TaskListScope = 'current-session',
  ): Promise<void> => {
    const targetSessionId = scope === 'workspace' ? undefined : sessionId
    const expectedActiveSessionId = state.activeSessionId
    const workspaceFolderId = sessionId === undefined ? undefined : sessionWorkspaceFolderId(sessionId)
    if (
      typeof client.featureRequest !== 'function' ||
      (scope === 'current-session' && targetSessionId === undefined) ||
      // Both task views are rooted in the folder the Host resolved; with no
      // folder open there is no scope to read, so nothing is requested.
      workspaceFolderId === undefined
    )
      return
    const generation = ++tasksRefreshGeneration
    setState((current) => ({ ...current, tasksLoading: true }))
    try {
      const result = await client.featureRequest({
        type: 'tasks.list',
        requestId: requestId(),
        payload: {
          ...(targetSessionId === undefined ? {} : { sessionId: targetSessionId }),
          workspaceFolderId,
          scope,
          includeCompleted,
          limit: 200,
        },
      })
      const snapshot = parseFeatureTasksResult(result)
      if (snapshot !== undefined)
        setState((current) =>
          generation === tasksRefreshGeneration && current.activeSessionId === expectedActiveSessionId
            ? {
                ...current,
                tasks: snapshot.items,
                taskScope: snapshot.scope,
                tasksComplete: snapshot.complete,
                tasksOmittedSessions: snapshot.omittedSessions,
              }
            : current,
        )
    } finally {
      if (generation === tasksRefreshGeneration) setState((current) => ({ ...current, tasksLoading: false }))
    }
  }
  // Path-scoped feature routes accept only the VS Code folder the Host
  // resolved for the session; the DSH workspace id is a different namespace
  // and a session row without this value means no folder is open at all.
  const sessionWorkspaceFolderId = (sessionId: string): string | undefined => {
    const session = state.sessions.find((candidate) => candidate.id === sessionId)
    if (session?.workspaceFolderId !== undefined) return session.workspaceFolderId
    const subagent = state.activeSubagent
    if (subagent?.entry.id !== sessionId) return undefined
    // A catalog-resolved child has no workspace row of its own; its paths
    // belong to the parent session it was delegated from.
    return state.sessions.find((candidate) => candidate.id === subagent.entry.parentSessionId)
      ?.workspaceFolderId
  }
  const refreshCheckpointsState = async (
    sessionId: string | undefined = state.activeSessionId,
  ): Promise<void> => {
    if (typeof client.featureRequest !== 'function' || sessionId === undefined) return
    const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
    if (workspaceFolderId === undefined) return
    const generation = ++checkpointsRefreshGeneration
    setState((current) => ({ ...current, checkpointsLoading: true }))
    try {
      const result = await client.featureRequest({
        type: 'checkpoint.list',
        requestId: requestId(),
        payload: { sessionId, workspaceFolderId },
      })
      const checkpoints = parseFeatureCheckpointsResult(result)
      if (checkpoints === undefined) throw new Error('Invalid checkpoint list')
      if (checkpoints !== undefined)
        setState((current) =>
          generation === checkpointsRefreshGeneration && current.activeSessionId === sessionId
            ? {
                ...current,
                checkpoints,
                unavailableLists: (current.unavailableLists ?? []).filter((key) => key !== 'checkpoints'),
              }
            : current,
        )
    } catch {
      if (generation === checkpointsRefreshGeneration && state.activeSessionId === sessionId)
        setState((current) => ({
          ...current,
          unavailableLists: [...new Set([...(current.unavailableLists ?? []), 'checkpoints'])],
        }))
    } finally {
      if (generation === checkpointsRefreshGeneration)
        setState((current) => ({ ...current, checkpointsLoading: false }))
    }
  }
  const refreshPromptTemplatesState = async (
    sessionId: string | undefined = state.activeSessionId,
    scope?: PromptTemplateScope,
  ): Promise<void> => {
    if (typeof client.featureRequest !== 'function' || sessionId === undefined) return
    const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
    if (workspaceFolderId === undefined) return
    const generation = ++promptTemplatesRefreshGeneration
    setState((current) => ({ ...current, promptTemplatesLoading: true }))
    try {
      const result = await client.featureRequest({
        type: 'prompt.template.list',
        requestId: requestId(),
        payload: { sessionId, workspaceFolderId, ...(scope === undefined ? {} : { scope }) },
      })
      const templates = parseFeaturePromptTemplatesResult(result)
      if (templates === undefined) throw new Error('Invalid prompt template list')
      if (templates !== undefined)
        setState((current) =>
          generation === promptTemplatesRefreshGeneration && current.activeSessionId === sessionId
            ? {
                ...current,
                promptTemplates: templates,
                unavailableLists: (current.unavailableLists ?? []).filter((key) => key !== 'templates'),
              }
            : current,
        )
    } catch {
      if (generation === promptTemplatesRefreshGeneration && state.activeSessionId === sessionId)
        setState((current) => ({
          ...current,
          unavailableLists: [...new Set([...(current.unavailableLists ?? []), 'templates'])],
        }))
    } finally {
      if (generation === promptTemplatesRefreshGeneration)
        setState((current) => ({ ...current, promptTemplatesLoading: false }))
    }
  }
  const applyBusyEnter = (values: Readonly<Record<string, unknown>>): void => {
    const conversation = object(values['ui-conversation'])
    const busyEnter = conversation?.busyEnter
    if (busyEnter === 'queue' || busyEnter === 'steer')
      setState((current) => (current.busyEnter === busyEnter ? current : { ...current, busyEnter }))
  }
  const applyBusyEnterPreference = async (): Promise<void> => {
    try {
      const snapshot = parseDshSettingsSnapshot(
        await client.request<unknown>({ type: 'settings.read', requestId: requestId() }),
      )
      if (snapshot !== undefined) applyBusyEnter(snapshot.values)
    } catch {
      // A host that cannot serve settings yet keeps the official 'queue' default.
    }
  }
  const releaseEditorContextRefs = async (
    refs: readonly string[],
    items: readonly EditorContextItem[],
  ): Promise<void> => {
    if (typeof client.featureRequest !== 'function') return
    const itemsByRef = new Map(items.map((item) => [item.ref.contextRef, item]))
    const grouped = new Map<string, string[]>()
    for (const contextRef of refs) {
      const item = itemsByRef.get(contextRef)
      if (item === undefined) continue
      const group = grouped.get(item.ref.workspaceFolderId) ?? []
      group.push(contextRef)
      grouped.set(item.ref.workspaceFolderId, group)
    }
    await Promise.all(
      [...grouped].map(([workspaceFolderId, contextRefs]) =>
        client.featureRequest({
          type: 'editor.context.release',
          requestId: requestId(),
          payload: { contextRefs, workspaceFolderId },
        }),
      ),
    )
  }
  const discardEditorContextForSessionSwitch = async (nextSessionId: string): Promise<void> => {
    if (state.activeSessionId === undefined || state.activeSessionId === nextSessionId) return
    const refs = state.editorContext.map((item) => item.ref.contextRef)
    if (refs.length === 0) return
    const items = [...state.editorContext]
    // Clear the Webview immediately so a slow release cannot leave context
    // chips visually attached to the next session. The Host remains the
    // authority and will reject any stale in-flight resolution by generation
    // or owner/session binding.
    setState((current) => ({
      ...current,
      editorContext: [],
      editorContextAvailableKinds: [],
      editorContextLoading: false,
    }))
    try {
      await releaseEditorContextRefs(refs, items)
    } catch {
      // Expired or already-released handles are harmless during a view switch.
    }
  }
  const discardEditorContextForWorkspaceChange = async (): Promise<void> => {
    editorContextRefreshGeneration += 1
    const refs = state.editorContext.map((item) => item.ref.contextRef)
    if (refs.length === 0) {
      setState((current) => ({
        ...current,
        editorContext: [],
        editorContextAvailableKinds: [],
        editorContextLoading: false,
      }))
      return
    }
    const items = [...state.editorContext]
    setState((current) => ({
      ...current,
      editorContext: [],
      editorContextAvailableKinds: [],
      editorContextLoading: false,
    }))
    try {
      await releaseEditorContextRefs(refs, items)
    } catch {
      // Workspace changes dispose the Host handles; stale releases are harmless.
    }
  }
  const executeCommandRequest = async (
    sessionId: string,
    command: string,
    attachments: readonly PromptAttachment[] = [],
  ): Promise<'executed' | 'unknown'> => {
    const result = object(
      await client.request<unknown>({
        type: 'command.execute',
        requestId: requestId(),
        payload: { sessionId, command, attachments: [...attachments] },
      }),
    )
    if (result?.kind === 'error')
      throw new Error(typeof result.text === 'string' ? result.text : translate('app.error.dshMode'))
    // A line outside DSH's command directory is not a command. The official
    // client lets it fall to the default sink, where the host injects a
    // user-invocable skill (the `/skill-name args` gesture) and any other line
    // reaches the model as ordinary text.
    if (result?.kind === 'unknown') return 'unknown'
    if (result !== undefined && result?.kind !== 'success') throw new Error(translate('app.error.dshMode'))
    setState((current) => {
      if (current.activeSessionId !== sessionId || current.configuration === undefined) return current
      const nextConfiguration = applyKnownCommand(current.configuration, command)
      const nextPromptMode = promptModeAfterCommand(current.promptMode, command)
      return {
        ...current,
        configuration: nextConfiguration,
        ...(nextPromptMode === undefined ? {} : { promptMode: nextPromptMode }),
      }
    })
    const nextPromptMode = promptModeAfterCommand(state.promptMode, command)
    if (nextPromptMode !== undefined) {
      composerPreferences = { ...composerPreferences, promptMode: nextPromptMode }
      persistWebviewState()
    }
    return 'executed'
  }
  /** Admit one ordinary turn (or subagent message) addressed to this session. */
  const sendUserTurn = async (
    sessionId: string,
    text: string,
    attachments: readonly PromptAttachment[],
    mode: RunningInputMode,
    subagent: ActiveSubagent | undefined,
  ): Promise<void> => {
    const rpcRequestId = requestId()
    const optimisticId = `optimistic:user:${rpcRequestId}`
    const contextRefs = state.editorContext.map((item) => item.ref.contextRef)
    const contextWorkspaceIds = new Set(
      state.editorContext
        .filter((item) => contextRefs.includes(item.ref.contextRef))
        .map((item) => item.ref.workspaceFolderId),
    )
    const contextWorkspaceFolderId = contextWorkspaceIds.size === 1 ? [...contextWorkspaceIds][0] : undefined
    // A queued prompt is not a conversation turn yet.  DSH publishes the
    // durable `message.user` event only when the queue admits it; rendering
    // a local preview here makes the same text appear both in the timeline
    // and in the queue dock.  Subagent sends bypass the session queue, and
    // steer is already admitted to the running turn, so those retain the
    // optimistic preview.
    const showOptimisticPreview = subagent !== undefined || mode === 'steer'
    if (subagent !== undefined) {
      if (subagent.entry.mode === 'one-shot') throw new Error(translate('app.error.subagentReadOnly'))
      if (!subagent.parentAvailable) throw new Error(translate('app.error.subagentParentUnavailable'))
      if (attachments.length > 0 && state.subagentImagePrompts !== true)
        throw new Error(translate('app.error.subagentAttachments'))
      if (text.trim() === '') throw new Error(translate('app.error.subagentMessageRequired'))
    }
    const messageAttachments: readonly MessageAttachment[] = attachments.map((attachment) => ({
      name: attachment.name,
      ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
    }))
    if (showOptimisticPreview && (text !== '' || messageAttachments.length > 0))
      setState((current) => {
        if (current.activeSessionId !== sessionId) return current
        return {
          ...current,
          timeline: {
            ...current.timeline,
            nodeChangeBase: current.timeline.nodes,
            nodeChangeStart: current.timeline.nodes.length,
            nodes: [
              ...current.timeline.nodes,
              {
                kind: 'user-message',
                id: optimisticId,
                markdown: text,
                ...(messageAttachments.length === 0 ? {} : { attachments: messageAttachments }),
              },
            ],
          },
        }
      })
    try {
      if (subagent === undefined)
        await client.request<unknown>({
          type: 'session.sendPrompt',
          requestId: rpcRequestId,
          payload: {
            sessionId,
            text,
            attachments: [...attachments],
            ...(contextRefs.length === 0 ? {} : { contextRefs }),
            ...(contextWorkspaceFolderId === undefined ? {} : { contextWorkspaceFolderId }),
            mode,
          },
        })
      else
        await client.request<unknown>({
          type: 'subagent.send',
          requestId: rpcRequestId,
          payload: {
            sessionId,
            message: text,
            mode,
            ...(attachments.length === 0 ? {} : { attachments: [...attachments] }),
          },
        })
      // The Extension Host released exactly the handles this snapshot named.
      // A chip captured while the request was in flight is a different handle
      // that is still live on the host, so only the admitted refs drop out —
      // mirroring how in-flight attachment drafts are kept.
      if (subagent === undefined && contextRefs.length > 0) {
        const admitted = new Set(contextRefs)
        setState((current) => ({
          ...current,
          editorContext: current.editorContext.filter((item) => !admitted.has(item.ref.contextRef)),
        }))
      }
    } catch (reason) {
      if (showOptimisticPreview)
        setState((current) => ({
          ...current,
          timeline: {
            ...current.timeline,
            nodeChangeBase: current.timeline.nodes,
            nodeChangeStart: 0,
            nodes: current.timeline.nodes.filter((node) => node.id !== optimisticId),
          },
        }))
      throw reason
    }
  }
  const unsubscribe = client.subscribe((message) => {
    const parsedEvent = parseHostDomainEvent(message)
    const messageSessionId =
      parsedEvent === undefined || parsedEvent === null ? undefined : backendEventSessionId(parsedEvent)
    const previousLastSequence = state.timeline.lastSequence
    let deferredToOpen = false
    let pendingOpenReady = false
    if (messageSessionId !== undefined) {
      const pending = latestPendingOpen.get(messageSessionId)
      if (pending !== undefined) {
        appendPendingMessage(pending, message)
        deferredToOpen = true
        pendingOpenReady = pending.ready
        // History/configuration is the open barrier; advisory reads must not
        // keep live model/tool events hidden after the first conversation
        // paint. Retain the message in the queue so the final advisory
        // snapshot can replay it after its potentially stale list response.
        if (pending.ready && pending.version === openVersion && state.activeSessionId === pending.sessionId)
          applyHostMessage(
            message,
            state,
            setState,
            appendLiveHistory,
            parsedEvent,
            scheduleGapBackfill,
            projectionSequences,
            rememberHostOnlyNodes,
          )
      }
    }
    // A session can be reopened while it is still active. Applying its live
    // event immediately and replaying it over the freshly hydrated history
    // would duplicate deltas, queue rows, and interaction requests. Defer
    // only events addressed to an in-flight open; global connection/workspace
    // events continue to update the shell while the read is in progress.
    if (!deferredToOpen)
      applyHostMessage(
        message,
        state,
        setState,
        appendLiveHistory,
        parsedEvent,
        scheduleGapBackfill,
        projectionSequences,
        rememberHostOnlyNodes,
        reopenActiveView,
      )
    // Content frames that history recovery redelivers below the timeline
    // cursor are absorbed into the ledger but ignored by the reduce gate.
    // Republish the ledger once so the healed range becomes visible.
    if (
      parsedEvent !== undefined &&
      parsedEvent !== null &&
      (!deferredToOpen || pendingOpenReady) &&
      state.activeSessionId !== undefined &&
      messageSessionId === state.activeSessionId &&
      parsedEvent.sequence !== undefined &&
      timelineSequenceOptions(parsedEvent).advanceSequence !== false &&
      parsedEvent.sequence <= previousLastSequence
    )
      scheduleLedgerRebuild(state.activeSessionId)
    // The switcher only caches its rows, so a session whose title changed
    // while the drawer was closed (a missed live frame, a reconnect gap, or a
    // title generated before this client attached) would keep showing the
    // stale value. Re-fetch the authoritative list whenever the drawer opens,
    // mirroring the subagent drawer's open-reads-fresh behavior.
    if (
      !deferredToOpen &&
      message.type === 'event' &&
      message.name === 'ui.sessions.toggle' &&
      state.drawer === 'sessions'
    )
      void refresh()
    if (
      message.type === 'event' &&
      ((message.name === 'remote.event' && object(message.payload)?.name === 'plugin-manager/changed') ||
        (message.name === 'connection.snapshot' && object(message.payload)?.kind === 'connected'))
    )
      setState((current) => ({ ...current, pluginInventoryRevision: current.pluginInventoryRevision + 1 }))
    if (
      message.type === 'event' &&
      message.name === 'remote.event' &&
      object(message.payload)?.name === 'goal/activation-changed'
    )
      goalActivationAvailable = true
    if (
      message.type === 'event' &&
      (message.name === 'connection.lost' ||
        (message.name === 'connection.snapshot' && object(message.payload)?.kind !== 'connected'))
    ) {
      goalActivationAvailable = false
      goalReadGeneration += 1
    }
    if (
      message.type === 'event' &&
      ((message.name === 'remote.event' && object(message.payload)?.name === 'goal/activation-changed') ||
        message.name === 'goal.updated' ||
        message.name === 'session.status' ||
        message.name === 'session.subscribed' ||
        (message.name === 'connection.snapshot' && object(message.payload)?.kind === 'connected'))
    )
      void refreshLiveGoals()
    if (
      message.type === 'event' &&
      message.name === 'remote.event' &&
      object(message.payload)?.name === 'permission-presets/catalog-changed'
    ) {
      const sessionId = state.activeSessionId
      const version = openVersion
      const generation = ++permissionCatalogGeneration
      // Clear the stale allowlist immediately; a failed read must not keep Auto
      // selectable after its live integration has been removed.
      setState((current) => ({ ...current, permissionPresets: [] }))
      if (sessionId !== undefined)
        void client
          .request<unknown>({
            type: 'session.open',
            requestId: requestId(),
            payload: { sessionId },
          })
          .then((value) => {
            if (
              disposed ||
              version !== openVersion ||
              generation !== permissionCatalogGeneration ||
              state.activeSessionId !== sessionId
            )
              return
            const permissionPresets = stringList(object(value)?.permissionPresets)
            if (permissionPresets !== undefined) setState((current) => ({ ...current, permissionPresets }))
          })
          .catch(() => {
            /* Preserve the fail-closed roster; reopening retries the read. */
          })
    }
    if (
      message.type === 'event' &&
      message.name === 'remote.event' &&
      isCommandDirectoryRefresh(message.payload)
    )
      void refreshCommands(undefined, true)
    if (
      message.type === 'event' &&
      message.name === 'remote.event' &&
      isModelCatalogRefresh(message.payload)
    ) {
      void refreshProvidersAndModels(client, setState)
      // The same host events invalidate the session-scoped directory. Without
      // this re-read a failure row the picker is showing would outlive its
      // cause, for example after the user repairs the credential it names.
      const refreshSessionId = state.activeSessionId
      if (refreshSessionId !== undefined)
        void refreshSessionModelDirectory(client, setState, refreshSessionId)
    }
    if (
      message.type === 'event' &&
      message.name === 'connection.snapshot' &&
      object(message.payload)?.kind === 'connected'
    ) {
      commandDirectoryGeneration += 1
      commandDirectoryCache.clear()
      commandDirectoryLoads.clear()
      void refreshCommands(undefined, true)
    }
    if (message.type === 'event' && message.name === 'connection.lost') {
      commandDirectoryGeneration += 1
      commandDirectoryCache.clear()
      commandDirectoryLoads.clear()
      invalidateFeedback()
    }
    if (
      message.type === 'event' &&
      (message.name === 'workspace.changed' || message.name === 'workspace.removed')
    )
      void discardEditorContextForWorkspaceChange()
    if (
      message.type === 'event' &&
      (message.name === 'workspace.changed' ||
        message.name === 'workspace.removed' ||
        message.name === 'workspace.order.changed' ||
        message.name === 'archived.sessions.changed' ||
        message.name === 'session.added' ||
        message.name === 'session.removed')
    )
      void refresh()
    if (message.type === 'event' && message.name === 'session.created') {
      const created = object(message.payload)
      const createdId = typeof created?.id === 'string' ? created.id : undefined
      if (createdId !== undefined) {
        // This is an explicit creation path. It owns the startup choice and
        // must not race the fallback selected from a concurrent refresh.
        startupRestorePending = false
        void refresh()
          .then(() => callbacks.openCreatedSession?.(createdId))
          .catch(() => undefined)
      }
    }
    if (message.type === 'event' && message.name === 'session.added') {
      const added = object(message.payload)
      const parentSessionId =
        added?.origin === 'subagent' && typeof added.parentSessionId === 'string'
          ? added.parentSessionId
          : undefined
      if (parentSessionId !== undefined && parentSessionId === state.activeSessionId)
        void loadSubagentCatalog(parentSessionId).then((catalog) => {
          if (catalog !== undefined)
            setState((current) =>
              current.activeSessionId === parentSessionId ? { ...current, subagents: catalog } : current,
            )
        })
    }
    if (
      message.type === 'event' &&
      (message.name === 'session.subscribed' || message.name === 'subagent.catalog.updated')
    ) {
      const subscribed = object(message.payload)
      const sessionId = typeof subscribed?.sessionId === 'string' ? subscribed.sessionId : undefined
      if (sessionId !== undefined && sessionId === state.activeSessionId)
        void loadSubagentCatalog(sessionId).then((catalog) => {
          if (catalog !== undefined)
            setState((current) =>
              current.activeSessionId === sessionId ? { ...current, subagents: catalog } : current,
            )
        })
    }
  })
  const unsubscribeFeature =
    typeof client.subscribeFeature === 'function'
      ? client.subscribeFeature((message) => {
          if (message.name === 'editor.context.changed') void refreshEditorContextState()
          if (message.name === 'editor.context.availability.changed') {
            const availableKinds = parseEditorContextAvailableKinds(message.availableKinds)
            if (availableKinds !== undefined)
              setState((current) => ({ ...current, editorContextAvailableKinds: availableKinds }))
          }
          if (message.name === 'changes.invalidated' && message.sessionId === state.activeSessionId)
            void refreshChangesState(message.sessionId)
          if (message.name === 'changes.updated' && message.change.sessionId === state.activeSessionId)
            void refreshChangesState(message.change.sessionId)
          if (
            message.name === 'tasks.updated' &&
            (state.taskScope === 'workspace' || message.task.sessionId === state.activeSessionId)
          )
            void refreshTasksState(
              state.taskScope === 'workspace' ? undefined : message.task.sessionId,
              false,
              state.taskScope,
            )
          if (message.name === 'checkpoint.updated' && message.checkpoint.sessionId === state.activeSessionId)
            void refreshCheckpointsState(message.checkpoint.sessionId)
        })
      : () => undefined
  const requestSessionOpen = async (sessionId: string, version: number): Promise<unknown> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await client.request<unknown>({
          type: 'session.open',
          requestId: requestId(),
          payload: { sessionId },
        })
      } catch (reason) {
        if (attempt >= OPEN_RETRY_ATTEMPTS || version !== openVersion || !isRetryableOpenFailure(reason))
          throw reason
        await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)))
        // A newer open() owns the panel now; do not re-request the stale one.
        if (version !== openVersion) throw reason
      }
    }
  }
  const requestFeedbackSnapshot = (sessionId: string, force = false): Promise<FeedbackListResult> => {
    if (force) feedbackReadySessions.delete(sessionId)
    if (!force && feedbackReadySessions.has(sessionId) && state.activeSessionId === sessionId) {
      return Promise.resolve({
        items: Object.values(state.feedback),
        unavailable: state.feedbackUnavailable === true,
      })
    }
    const existing = feedbackLoads.get(sessionId)
    if (existing !== undefined) return existing
    const generation = feedbackGeneration
    const pending = safeFeedbackList(client, sessionId).then((result) => {
      if (generation === feedbackGeneration && (result.items !== undefined || result.unavailable === true))
        feedbackReadySessions.add(sessionId)
      return result
    })
    feedbackLoads.set(sessionId, pending)
    void pending.finally(() => {
      if (feedbackLoads.get(sessionId) === pending) feedbackLoads.delete(sessionId)
    })
    return pending
  }
  const applyFeedbackSnapshot = (sessionId: string, result: FeedbackListResult): void => {
    setState((current) => {
      if (current.activeSessionId !== sessionId) return current
      return {
        ...current,
        ...(result.items === undefined ? {} : { feedback: feedbackRecord(result.items) }),
        ...(result.unavailable === undefined ? {} : { feedbackUnavailable: result.unavailable }),
      }
    })
  }
  /**
   * A subagent child is a view onto its parent's catalog, never a root session:
   * its follow-up prompt, Stop, lineage header, and one-shot read-only guard all
   * key off `activeSubagent`. The registry projection does name children (the
   * drawer, mention links, and lineage entries rely on that), so any path that
   * asks to open one — a reload restoring the persisted view, a session mention,
   * a lineage hop, a task row — has to be presented through the catalog the
   * subagent view is built from. When the catalog no longer lists the child, the
   * nearest ancestor that it does list is the only place the transcript is still
   * reachable from.
   */
  const resolveSubagentOpen = async (
    sessionId: string,
  ): Promise<
    | { readonly kind: 'subagent'; readonly entry: SubagentView; readonly parentAvailable: boolean }
    | { readonly kind: 'session'; readonly sessionId: string }
  > => {
    const visited = new Set<string>([sessionId])
    let target = sessionId
    for (;;) {
      const summary = state.sessions.find((session) => session.id === target)
      if (summary?.origin !== 'subagent' || summary.parentSessionId === undefined) break
      const catalog = await loadSubagentCatalog(summary.parentSessionId)
      // A diagnostic entry is not presentable: `isSubagentView` keeps the climb
      // going so those stay unreachable rather than half-openable.
      const entry = catalog?.entries.find(
        (candidate): candidate is SubagentView => isSubagentView(candidate) && candidate.id === target,
      )
      if (catalog !== undefined && entry !== undefined)
        return { kind: 'subagent', entry, parentAvailable: catalog.parentAvailable }
      // Malformed lineage must not walk forever; fall back to the named session.
      if (visited.has(summary.parentSessionId)) return { kind: 'session', sessionId }
      visited.add(summary.parentSessionId)
      target = summary.parentSessionId
    }
    return { kind: 'session', sessionId: target }
  }
  const open = async (
    requestedSessionId: string,
    options: { readonly startup?: boolean } = {},
  ): Promise<void> => {
    let sessionId = requestedSessionId
    // Claims the intent slot before any await. A root open stays fully
    // synchronous up to its buffer registration, or an event delivered while
    // the open is in flight lands outside the replay barrier; only a subagent
    // child pays the catalog read, and that read can be superseded.
    const intent = ++openIntent
    if (
      state.sessions.some((session) => session.id === requestedSessionId && session.origin === 'subagent')
    ) {
      const resolution = await resolveSubagentOpen(requestedSessionId)
      if (intent !== openIntent) return
      if (resolution.kind === 'subagent') {
        await openSubagent(resolution.entry, resolution.parentAvailable)
        return
      }
      sessionId = resolution.sessionId
    }
    if (
      state.activeSessionId !== undefined &&
      state.activeSessionId !== sessionId &&
      state.jobFollow !== undefined
    ) {
      const previousFollow = state.jobFollow
      void client
        .request<unknown>({
          type: 'job.follow.stop',
          requestId: requestId(),
          payload: { sessionId: state.activeSessionId, jobId: previousFollow.jobId },
        })
        .catch(() => undefined)
    }
    if (options.startup !== true) startupRestorePending = false
    flushPendingHistory()
    const version = ++openVersion
    feedbackReadySessions.delete(sessionId)
    editorContextRefreshGeneration += 1
    changesRefreshGeneration += 1
    tasksRefreshGeneration += 1
    checkpointsRefreshGeneration += 1
    promptTemplatesRefreshGeneration += 1
    const pending = createPendingOpen(sessionId, version)
    // Events delivered after this open began must be replayed after the
    // advisory snapshots, even when the critical history request has not
    // produced first paint yet.
    const advisoryReplayStart = pending.messages.length
    let completed = false
    let advisoryPending = false
    try {
      await discardEditorContextForSessionSwitch(sessionId)
      let result: unknown
      try {
        result = await requestSessionOpen(sessionId, version)
      } catch (reason) {
        // A newer open() owns the panel; a stale failure is irrelevant noise.
        if (version !== openVersion) return
        throw reason
      }
      const detail = object(result)
      if (!isSessionOpenDetail(detail, sessionId)) throw new Error(translate('app.error.openSession'))
      const rawHistory = detail.history
      const parsedHistory = parseSessionHistoryWithTimeline(rawHistory)
      const history = parsedHistory.history
      // Host-only rows (command notices, agent errors, unhealed gap warnings)
      // are not part of the ledger this hydration reads, so a re-open has to
      // put back the ones the session already announced.
      const timeline = restoreHostOnlyNodes(
        restoreGapNotices(hydrateTimelineFromEntries(sessionId, parsedHistory.timeline), sessionId, history),
        sessionId,
      )
      const permissionPresets = stringList(detail?.permissionPresets)
      // The Host resolves which VS Code folder guards this session's paths and
      // states it on the open detail; a row from an earlier list is the
      // fallback. Without it the folder-scoped surfaces are not attempted.
      const openedWorkspaceFolderId = detail?.workspaceFolderId
      const workspaceFolderId = nonEmptyString(openedWorkspaceFolderId)
        ? openedWorkspaceFolderId
        : sessionWorkspaceFolderId(sessionId)
      // History and configuration are the critical first-paint payload. Start
      // the advisory reads immediately, but publish the conversation before
      // they finish so a slow queue/catalog endpoint cannot blank the panel.
      // The command and session-model directories are also advisory for the
      // first paint: the composer can use the global model fallback and the
      // command picker is opened explicitly. Keep their requests concurrent,
      // but do not make their latency part of the session-open completion.
      const commandDirectoryData = loadCommandDirectory(sessionId)
      const sessionModelDirectoryData = loadSessionModelDirectory(client, sessionId)
      const goalBaselineGeneration = goalReadGeneration
      const secondaryData = Promise.all([
        safeList<QueuedInput>(
          client,
          { type: 'session.queue.list', requestId: requestId(), payload: { sessionId } },
          isQueuedInput,
        ),
        safeList<GoalView>(
          client,
          { type: 'goal.list', requestId: requestId(), payload: { sessionId } },
          isGoalView,
        ),
        safeList<JobView>(
          client,
          { type: 'job.list', requestId: requestId(), payload: { sessionId } },
          isJobView,
        ),
        requestFeedbackSnapshot(sessionId),
        loadSubagentCatalog(sessionId),
      ])
      if (version !== openVersion) return
      const initialMessages = pendingMessagesAfterReplay(pending)
      setState((current) =>
        replayHostMessages(
          {
            ...current,
            activeSessionId: sessionId,
            timeline,
            history,
            historyHasMore: detail?.historyHasMore === true,
            historyBeforeSequence:
              optionalSequence(detail?.historyBeforeSequence) ??
              (detail?.historyHasMore === true ? oldestHistorySequence(history) : undefined),
            historyLoading: false,
            projections: setSessionProjection(
              current.projections,
              sessionId,
              detail?.projection,
              projectionSequences,
            ),
            sessions: upsertOpenedSession(current.sessions, detail, sessionId),
            configuration: isAgentConfiguration(detail?.configuration)
              ? detail.configuration
              : {
                  ...createDefaultConfiguration(current, composerPreferences),
                  planModeKnown: false,
                  permissionPresetKnown: false,
                },
            sessionModels: [],
            sessionModelFailures: [],
            sessionModelCurrent: undefined,
            sessionModelRoutable: undefined,
            // The directory read starts below, before the first paint, so it is
            // in flight from the moment the session is on screen.
            sessionModelDirectoryLoading: true,
            sessionModelDirectoryError: undefined,
            permissionPresets: permissionPresets ?? [],
            queue: [],
            goals: [],
            todos: latestTodos(timeline),
            jobs: [],
            jobFollow: undefined,
            feedback: {},
            feedbackUnavailable: false,
            subagents: EMPTY_SUBAGENT_CATALOG,
            activeSubagent: undefined,
            changes: [],
            changesRefreshFailed: false,
            changesLoading: false,
            // A refresh superseded by this open can no longer clear its own
            // loading flag, so the reset has to release it.
            editorContextLoading: false,
            tasks: [],
            tasksLoading: false,
            taskScope: 'current-session',
            tasksComplete: true,
            tasksOmittedSessions: 0,
            checkpoints: [],
            unavailableLists: [],
            checkpointsLoading: false,
            promptTemplates: [],
            promptTemplatesLoading: false,
            promptMode: promptModeForConfiguration(
              current.promptMode,
              isAgentConfiguration(detail?.configuration) ? detail.configuration.planMode : false,
            ),
            commands: commandDirectoryCache.get(sessionId) ?? [],
          },
          initialMessages,
          scheduleGapBackfill,
          projectionSequences,
          rememberHostOnlyNodes,
        ),
      )
      pending.ready = true
      // Keep the open barrier registered until the advisory snapshots merge.
      // Events arriving after first paint must be replayed over those
      // snapshots; otherwise a stale queue/job response can overwrite a live
      // update that arrived while the reads were in flight.
      advisoryPending = true
      persistWebviewState({ activeSessionId: sessionId })

      void commandDirectoryData
        .then((commands) => {
          if (version !== openVersion || commands === undefined) return
          setState((current) =>
            current.activeSessionId === sessionId && current.commands !== commands
              ? { ...current, commands }
              : current,
          )
        })
        .catch(() => undefined)
      void sessionModelDirectoryData.then((read) => {
        if (version !== openVersion) return
        setState((current) => mergeSessionModelDirectory(current, sessionId, read))
      })

      // Queue/goal/job/feedback/subagent data is advisory. It must not keep
      // the session-open promise (and therefore startup/manual navigation)
      // hostage to any one slow endpoint. The first paint above is complete;
      // merge these surfaces when they arrive and replay any events that were
      // delivered during this short hydration window.
      void secondaryData
        .then(([queue, goals, jobs, feedback, subagents]) => {
          if (version !== openVersion) return
          if (
            goalBaselineGeneration === goalReadGeneration &&
            goals?.some((goal) => goal.activation !== undefined)
          )
            goalActivationAvailable = true
          // A gap event has already been applied live and may have triggered
          // an asynchronous history rebuild. Replaying it over the advisory
          // baseline would re-add a gap notice after the backfill removed it.
          const pendingMessages = pendingMessagesFrom(pending, advisoryReplayStart).filter(
            (message) => message.type !== 'event' || message.name !== 'session.gap',
          )
          setState((current) =>
            replayHostMessages(
              {
                ...current,
                unavailableLists: [
                  ...(current.unavailableLists ?? []).filter(
                    (key) => !['queue', 'goals', 'jobs'].includes(key),
                  ),
                  ...(queue === undefined ? ['queue'] : []),
                  ...(goals === undefined ? ['goals'] : []),
                  ...(jobs === undefined ? ['jobs'] : []),
                ],
                ...(queue === undefined ? {} : { queue }),
                ...(goals === undefined || goalBaselineGeneration !== goalReadGeneration ? {} : { goals }),
                ...(jobs === undefined ? {} : { jobs }),
                ...(feedback.items === undefined ? {} : { feedback: feedbackRecord(feedback.items) }),
                ...(feedback.unavailable === undefined ? {} : { feedbackUnavailable: feedback.unavailable }),
                ...(subagents === undefined ? {} : { subagents }),
              },
              pendingMessages,
              scheduleGapBackfill,
              projectionSequences,
              rememberHostOnlyNodes,
            ),
          )
          void refreshChangesState(sessionId)
          void refreshTasksState(sessionId)
          void refreshCheckpointsState(sessionId)
          void refreshPromptTemplatesState(sessionId)
          void refreshEditorContextState(workspaceFolderId)
        })
        .catch(() => undefined)
        .finally(() => {
          advisoryPending = false
          settlePendingOpen(pending, version === openVersion)
        })
      completed = true
    } finally {
      if (!advisoryPending) settlePendingOpen(pending, completed)
    }
  }
  const openSubagent = async (entry: SubagentView, parentAvailable: boolean): Promise<void> => {
    // A direct child open (drawer, task row) also supersedes an in-flight
    // by-id resolution inside `open`.
    openIntent += 1
    flushPendingHistory()
    const version = ++openVersion
    feedbackReadySessions.delete(entry.id)
    promptTemplatesRefreshGeneration += 1
    const pending = createPendingOpen(entry.id, version)
    // The history and advisory reads overlap. Preserve every event delivered
    // after this open began for the final advisory replay.
    const advisoryReplayStart = pending.messages.length
    let completed = false
    const workspaceId =
      state.sessions.find((session) => session.id === state.activeSessionId)?.workspaceId ??
      state.activeSubagent?.workspaceId ??
      ''
    try {
      await discardEditorContextForSessionSwitch(entry.id)
      // The child→parent routing is connection state owned by the host
      // catalog: a child transcript can only be read after its parent catalog
      // was read on *this* connection, and a replacement process starts
      // without one. Read it first instead of beside the history request; the
      // caller still owns `parentAvailable`, which it read from that catalog.
      await loadSubagentCatalog(entry.parentSessionId)
      const historyData = client
        .request<unknown>({
          type: 'subagent.history',
          requestId: requestId(),
          payload: { sessionId: entry.id },
        })
        .then(parseSubagentHistory)
      const goalBaselineGeneration = goalReadGeneration
      const secondaryData = Promise.all([
        safeList<QueuedInput>(
          client,
          { type: 'session.queue.list', requestId: requestId(), payload: { sessionId: entry.id } },
          isQueuedInput,
        ),
        safeList<GoalView>(
          client,
          { type: 'goal.list', requestId: requestId(), payload: { sessionId: entry.id } },
          isGoalView,
        ),
        safeList<JobView>(
          client,
          { type: 'job.list', requestId: requestId(), payload: { sessionId: entry.id } },
          isJobView,
        ),
        requestFeedbackSnapshot(entry.id),
        loadSubagentCatalog(entry.id),
      ])
      const history = await historyData
      if (version !== openVersion) return
      // A child transcript is rebuilt from `subagent.history` on every entry,
      // and DSH never replays host-only rows or an unhealed hole, so both
      // restores have to run exactly as they do for a parent open.
      const timeline = restoreHostOnlyNodes(
        restoreGapNotices(
          hydrateTimelineFromHistoryEvents(entry.id, history.events),
          entry.id,
          history.events,
        ),
        entry.id,
      )
      const initialMessages = pendingMessagesAfterReplay(pending)
      setState((current) =>
        replayHostMessages(
          {
            ...current,
            activeSessionId: entry.id,
            activeSubagent: { entry, parentAvailable, workspaceId },
            timeline,
            history: history.events,
            // A child transcript is paged exactly like a parent one: without the
            // host cursor (or a deriveable one) the transcript would stop at the
            // newest page with no way to reach the records before it.
            historyHasMore: history.hasMore,
            historyBeforeSequence:
              history.beforeSequence ?? (history.hasMore ? oldestHistorySequence(history.events) : undefined),
            historyLoading: false,
            projections: setSessionProjection(
              current.projections,
              entry.id,
              history.projection,
              projectionSequences,
            ),
            configuration: undefined,
            sessionModels: [],
            sessionModelFailures: [],
            sessionModelCurrent: undefined,
            sessionModelRoutable: undefined,
            // An addressed subagent has no session directory of its own — the
            // host binds this selection to the owning Agent — so there is no
            // read to track and nothing to state a failure about.
            sessionModelDirectoryLoading: false,
            sessionModelDirectoryError: undefined,
            permissionPresets: [],
            queue: [],
            goals: [],
            todos: latestTodos(timeline),
            jobs: [],
            jobFollow: undefined,
            feedback: {},
            feedbackUnavailable: false,
            subagents: EMPTY_SUBAGENT_CATALOG,
            commands: [],
            changes: [],
            changesRefreshFailed: false,
            changesLoading: false,
            editorContextLoading: false,
            tasks: [],
            tasksLoading: false,
            taskScope: 'current-session',
            tasksComplete: true,
            tasksOmittedSessions: 0,
            checkpoints: [],
            unavailableLists: [],
            checkpointsLoading: false,
            promptTemplates: [],
            promptTemplatesLoading: false,
            promptMode: 'ask',
          },
          initialMessages,
          scheduleGapBackfill,
          projectionSequences,
          rememberHostOnlyNodes,
        ),
      )
      pending.ready = true
      persistWebviewState({ activeSessionId: entry.id })

      const [queue, goals, jobs, feedback, subagents] = await secondaryData
      if (
        version === openVersion &&
        goalBaselineGeneration === goalReadGeneration &&
        goals?.some((goal) => goal.activation !== undefined)
      )
        goalActivationAvailable = true
      if (version !== openVersion) return
      const pendingMessages = pendingMessagesFrom(pending, advisoryReplayStart)
      setState((current) =>
        replayHostMessages(
          {
            ...current,
            unavailableLists: [
              ...(current.unavailableLists ?? []).filter((key) => !['queue', 'goals', 'jobs'].includes(key)),
              ...(queue === undefined ? ['queue'] : []),
              ...(goals === undefined ? ['goals'] : []),
              ...(jobs === undefined ? ['jobs'] : []),
            ],
            ...(queue === undefined ? {} : { queue }),
            ...(goals === undefined || goalBaselineGeneration !== goalReadGeneration ? {} : { goals }),
            ...(jobs === undefined ? {} : { jobs }),
            ...(feedback.items === undefined ? {} : { feedback: feedbackRecord(feedback.items) }),
            ...(feedback.unavailable === undefined ? {} : { feedbackUnavailable: feedback.unavailable }),
            ...(subagents === undefined ? {} : { subagents }),
          },
          pendingMessages,
          scheduleGapBackfill,
          projectionSequences,
          rememberHostOnlyNodes,
        ),
      )
      void refreshChangesState(entry.id)
      void refreshTasksState(entry.id)
      void refreshCheckpointsState(entry.id)
      void refreshPromptTemplatesState(entry.id)
      completed = true
    } finally {
      settlePendingOpen(pending, completed)
    }
  }
  /**
   * A replacement DSH process starts with no follow subscriptions of its own.
   * Whatever the user is looking at has to be re-baselined against the new
   * process, or the conversation silently stops receiving model and tool
   * events while the shell reports a healthy connection.
   *
   * `connected` is published before the replacement process has committed its
   * workspace projection, so the re-baseline can be rejected outright with the
   * definitive `retryable: false` answer `requireCurrentWorkspaceSession` gives
   * a session that is not (yet) part of the current workspace — the same race a
   * cold start recovers from by re-arming its restore. Retry it here with the
   * same bounded backoff, and stop as soon as the user looks at something else
   * so the panel never jumps back to the view that failed.
   */
  const resubscribeActiveView = async (): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      const subagent = state.activeSubagent
      const sessionId = subagent === undefined ? state.activeSessionId : subagent.entry.id
      if (sessionId === undefined) return
      try {
        if (subagent === undefined) await open(sessionId)
        else await openSubagent(subagent.entry, subagent.parentAvailable)
        return
      } catch {
        const stillCurrent =
          subagent === undefined
            ? state.activeSubagent === undefined && state.activeSessionId === sessionId
            : state.activeSubagent?.entry.id === sessionId
        if (attempt >= OPEN_RETRY_ATTEMPTS || !stillCurrent) return
        await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)))
      }
    }
  }
  const reopenActiveView = (): void => {
    void resubscribeActiveView()
    // The replacement process may expose a different catalog entirely; the
    // session switcher has to reflect that backend, not the previous one.
    void refresh()
  }
  callbacks.openCreatedSession = open
  const attemptStartupRestore = (): Promise<void> => {
    if (!startupRestorePending || state.activeSessionId !== undefined) return Promise.resolve()
    if (startupRestorePromise !== undefined) return startupRestorePromise
    const sessionId = selectStartupSessionId(
      state.sessions,
      state.workspaces,
      state.archivedSessionIds,
      persistedWebviewState.activeSessionId,
    )
    if (sessionId === undefined) return Promise.resolve()
    const restore = open(sessionId, { startup: true })
      .then(() => {
        if (state.activeSessionId === sessionId) startupRestorePending = false
      })
      .finally(() => {
        if (startupRestorePromise === restore) startupRestorePromise = undefined
      })
    startupRestorePromise = restore
    return restore
  }
  const checkDshUpdates = async (force = false): Promise<DshUpdateSnapshot | undefined> => {
    setState((current) => ({
      ...current,
      dshUpdateProgress: { phase: 'checking' },
    }))
    const snapshot = parseDshUpdateSnapshot(
      await client.request<unknown>({
        type: 'runtime.update.check',
        requestId: requestId(),
        payload: { force },
      }),
    )
    if (snapshot !== undefined) setState((current) => ({ ...current, dshUpdate: snapshot }))
    return snapshot
  }
  const installDshVersion = async (version: string): Promise<DshUpdateSnapshot | undefined> => {
    setState((current) => ({
      ...current,
      dshUpdateProgress: { phase: 'checking', version },
    }))
    const snapshot = parseDshUpdateSnapshot(
      await client.request<unknown>({
        type: 'runtime.update.install',
        requestId: requestId(),
        payload: { version },
      }),
    )
    if (snapshot !== undefined) setState((current) => ({ ...current, dshUpdate: snapshot }))
    return snapshot
  }
  return {
    get backend() {
      return state.backend
    },
    get connectedDshVersion() {
      return state.connectedDshVersion
    },
    get sessionRestore() {
      return state.sessionRestore === true
    },
    get subagentImagePrompts() {
      return state.subagentImagePrompts
    },
    get dshCompatibilityWarning() {
      return state.dshCompatibilityWarning
    },
    get featureProfile() {
      return state.featureProfile
    },
    get dshUpdate() {
      return state.dshUpdate
    },
    get dshUpdateProgress() {
      return state.dshUpdateProgress
    },
    get sessions() {
      return state.sessions
    },
    get archivedSessionIds() {
      return state.archivedSessionIds
    },
    get archivedSessions() {
      return state.archivedSessions
    },
    get workspaces() {
      return state.workspaces
    },
    get activeSessionId() {
      return state.activeSessionId
    },
    get preferredOpenFileId() {
      return state.preferredOpenFileId
    },
    get timeline() {
      return state.timeline
    },
    get history() {
      return state.history
    },
    get historyHasMore() {
      return state.historyHasMore
    },
    get historyBeforeSequence() {
      return state.historyBeforeSequence
    },
    get historyLoading() {
      return state.historyLoading
    },
    get projections() {
      return state.projections
    },
    get configuration() {
      return state.configuration
    },
    get providers() {
      return state.providers
    },
    get models() {
      return state.models
    },
    get sessionModels() {
      return state.sessionModels
    },
    get sessionModelFailures() {
      return state.sessionModelFailures
    },
    get sessionModelCurrent() {
      return state.sessionModelCurrent
    },
    get sessionModelRoutable() {
      return state.sessionModelRoutable
    },
    get sessionModelDirectoryLoading() {
      return state.sessionModelDirectoryLoading
    },
    get sessionModelDirectoryError() {
      return state.sessionModelDirectoryError
    },
    get presets() {
      return state.presets
    },
    get presetSelectionEnabled() {
      return state.presetSelectionEnabled
    },
    get permissionPresets() {
      return state.permissionPresets
    },
    get commands() {
      return state.commands
    },
    get pluginInventoryRevision() {
      return state.pluginInventoryRevision
    },
    get goals() {
      return state.goals
    },
    get todos() {
      return state.todos
    },
    get jobs() {
      return state.jobs
    },
    get jobControllerAvailable() {
      return state.jobControllerAvailable
    },
    get jobFollow() {
      return state.jobFollow
    },
    get feedback() {
      return state.feedback
    },
    get feedbackUnavailable() {
      return state.feedbackUnavailable ?? false
    },
    get subagents() {
      return state.subagents
    },
    get activeSubagent() {
      return state.activeSubagent
    },
    get queue() {
      return state.queue
    },
    get editorContext() {
      return state.editorContext
    },
    get editorContextAvailableKinds() {
      return state.editorContextAvailableKinds
    },
    get editorContextLoading() {
      return state.editorContextLoading
    },
    get changes() {
      return state.changes
    },
    get changesRefreshFailed() {
      return state.changesRefreshFailed
    },
    get changesLoading() {
      return state.changesLoading
    },
    get tasks() {
      return state.tasks
    },
    get tasksLoading() {
      return state.tasksLoading
    },
    get taskScope() {
      return state.taskScope
    },
    get tasksComplete() {
      return state.tasksComplete
    },
    get tasksOmittedSessions() {
      return state.tasksOmittedSessions
    },
    get checkpoints() {
      return state.checkpoints
    },
    get unavailableLists() {
      return state.unavailableLists ?? []
    },
    get checkpointsLoading() {
      return state.checkpointsLoading
    },
    get promptTemplates() {
      return state.promptTemplates
    },
    get promptTemplatesLoading() {
      return state.promptTemplatesLoading
    },
    get promptMode() {
      return state.promptMode
    },
    get permissions() {
      return state.permissions
    },
    get questions() {
      return state.questions
    },
    get busyEnter() {
      return state.busyEnter
    },
    get drawer() {
      return state.drawer
    },
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    initialize: async () => {
      // The update check is independent of DSH connectivity. Start it before
      // app.ready so a missing runtime does not suppress the startup notice;
      // the result is intentionally not on the critical connection path.
      void checkDshUpdates(false).catch(() => undefined)
      await client.request<unknown>({ type: 'app.ready', requestId: requestId() })
      // Official ui-conversation row: the host-side busy-Enter preference is
      // the composer's plain-Enter policy while a turn is running. It is
      // independent of the session/catalog snapshot. Start it alongside the
      // critical refresh, but keep the official default ('queue') on the
      // first-paint path when the settings read is slow or unavailable.
      startupRestoreArmed = true
      const refreshPromise = refresh()
      void applyBusyEnterPreference()
      await refreshPromise
      await attemptStartupRestore()
    },
    reconnect: async () => {
      invalidateFeedback()
      await client.request<unknown>({ type: 'connection.retry', requestId: requestId() })
      await refresh()
    },
    readDiagnostics: async () => {
      const parsed = diagnosticsSnapshotSchema.safeParse(
        await client.request<unknown>({ type: 'diagnostics.snapshot', requestId: requestId() }),
      )
      if (!parsed.success) return undefined
      return {
        extensionVersion: parsed.data.extensionVersion,
        ...(parsed.data.dshVersion === undefined ? {} : { dshVersion: parsed.data.dshVersion }),
        state: parsed.data.state,
        ...(parsed.data.endpointKind === undefined ? {} : { endpointKind: parsed.data.endpointKind }),
        canReconnect: parsed.data.canReconnect,
        recentEvents: parsed.data.recentEvents,
      }
    },
    showDiagnostics: async () => {
      await client.request<unknown>({ type: 'diagnostics.show', requestId: requestId() })
    },
    refreshSessions: refresh,
    searchSessions: async (query) => {
      const trimmed = query.trim()
      if (trimmed === '') return []
      const result = await client.request<unknown>({
        type: 'session.list',
        requestId: requestId(),
        payload: { search: trimmed, archived: false },
      })
      const items = strictListValues(result, isSessionSummary)
      return items === undefined ? [] : deduplicateSessionSummaries(items)
    },
    refreshCommands: (sessionId) => refreshCommands(sessionId),
    refreshSessionModels: async (sessionId) => {
      const target = sessionId ?? state.activeSessionId
      if (target === undefined) return
      await refreshSessionModelDirectory(client, setState, target)
    },
    openSession: open,
    loadOlderHistory: async () => {
      flushPendingHistory()
      const sessionId = state.activeSessionId
      const beforeSeq = state.historyBeforeSequence
      // A child transcript pages through `subagent.history`: its records live in
      // the parent's subagent log, so `session.history` would answer for the
      // wrong log.
      const childTranscript = state.activeSubagent !== undefined
      if (sessionId === undefined || !state.historyHasMore || beforeSeq === undefined || state.historyLoading)
        return
      const version = openVersion
      setState((current) =>
        current.activeSessionId === sessionId ? { ...current, historyLoading: true } : current,
      )
      try {
        const result = await client.request<unknown>(
          childTranscript
            ? {
                type: 'subagent.history',
                requestId: requestId(),
                payload: { sessionId, beforeSeq },
              }
            : {
                type: 'session.history',
                requestId: requestId(),
                payload: { sessionId, beforeSeq, maxMessages: 200 },
              },
        )
        const page = childTranscript ? parseSubagentHistory(result) : parseSessionHistoryPage(result)
        // Remember the raw window before the merge gate: a page that cannot be
        // merged (another open superseded this one, a discontinuous cursor) still
        // proves which sequences upstream has, which is what clears a warning.
        rememberCoveredRanges(sessionId, historyPageCoverage(page))
        // A live stream can publish while the paging request is in flight.
        // Flush the coalesced history ledger before taking the functional
        // update so the page is merged with the newest state, not the state
        // that existed when the request started.
        flushPendingHistory()
        let discontinuous = false
        setState((next) => {
          if (version !== openVersion || next.activeSessionId !== sessionId) return next
          const currentBase = next.historyBeforeSequence ?? oldestHistorySequence(next.history)
          const pageNewest = newestHistorySequence(page.events)
          if (pageNewest !== undefined && currentBase !== undefined && pageNewest >= currentBase) {
            discontinuous = true
            return { ...next, historyLoading: false }
          }
          const history = mergeHistory(next.history, page.events)
          const timeline = mergeLiveTransientNodes(
            restoreHostOnlyNodes(
              restoreGapNotices(hydrateTimelineFromHistoryEvents(sessionId, history), sessionId, history),
              sessionId,
            ),
            next.timeline,
            history,
          )
          const nextBefore = page.beforeSequence ?? oldestHistorySequence(page.events)
          const hasMore =
            page.hasMore &&
            nextBefore !== undefined &&
            (currentBase === undefined || nextBefore < currentBase)
          return {
            ...next,
            timeline,
            history,
            historyHasMore: hasMore,
            historyBeforeSequence: nextBefore,
            historyLoading: false,
            projections:
              page.projection === undefined
                ? next.projections
                : setSessionProjection(next.projections, sessionId, page.projection, projectionSequences),
            todos: latestTodos(timeline),
          }
        })
        if (discontinuous) throw new Error(translate('app.error.historyDiscontinuous'))
      } finally {
        if (version === openVersion && state.activeSessionId === sessionId && state.historyLoading)
          setState((current) =>
            current.activeSessionId === sessionId ? { ...current, historyLoading: false } : current,
          )
      }
    },
    openSubagent,
    renameSession: async (sessionId, title) => {
      const result = object(
        await client.request<unknown>({
          type: 'session.rename',
          requestId: requestId(),
          payload: { sessionId, title },
        }),
      )
      // The host answers with the title it stored after its own normalization
      // (control characters stripped, whitespace collapsed, truncated to its
      // byte budget). Adopting that value keeps the row from showing a title
      // the session log does not hold until the next refresh.
      const accepted =
        typeof result?.title === 'string' && result.title.trim() !== '' ? result.title : title.trim()
      setState((current) => ({
        ...current,
        sessions: current.sessions.map((session) =>
          session.id === sessionId ? { ...session, title: accepted } : session,
        ),
      }))
    },
    addWorkspaceFolder: async () => {
      await client.request<unknown>({ type: 'workspace.addFolder', requestId: requestId() })
    },
    renameWorkspace: async (workspaceId, name) => {
      await client.request<unknown>({
        type: 'workspace.rename',
        requestId: requestId(),
        payload: { workspaceId, name },
      })
      await refresh()
    },
    removeWorkspace: async (workspaceId) => {
      await client.request<unknown>({
        type: 'workspace.remove',
        requestId: requestId(),
        payload: { workspaceId },
      })
      await refresh()
    },
    moveWorkspace: async (workspaceId, beforeWorkspaceId) => {
      await client.request<unknown>({
        type: 'workspace.move',
        requestId: requestId(),
        payload: {
          workspaceId,
          ...(beforeWorkspaceId === undefined ? {} : { beforeWorkspaceId }),
        },
      })
      await refresh()
    },
    moveSession: async (workspaceId, sessionId, beforeSessionId) => {
      await client.request<unknown>({
        type: 'session.move',
        requestId: requestId(),
        payload: {
          workspaceId,
          sessionId,
          ...(beforeSessionId === undefined ? {} : { beforeSessionId }),
        },
      })
      await refresh()
    },
    forkSession: async (sessionId, atSeq) => {
      const navigationIntent = ++openIntent
      const source = state.sessions.find((session) => session.id === sessionId)
      const result = object(
        await client.request<unknown>({
          type: 'session.fork',
          requestId: requestId(),
          payload: {
            sessionId,
            ...(atSeq === undefined ? {} : { atSeq }),
          },
        }),
      )
      const childId =
        typeof result?.id === 'string'
          ? result.id
          : typeof result?.sessionId === 'string'
            ? result.sessionId
            : undefined
      if (childId === undefined || childId.trim() === '') throw new Error(translate('app.error.forkSession'))
      if (source !== undefined) {
        const childTitle = nextForkTitle(source.title, state.sessions, source.workspaceId)
        try {
          await client.request<unknown>({
            type: 'session.rename',
            requestId: requestId(),
            payload: { sessionId: childId, title: childTitle },
          })
        } catch (reason: unknown) {
          // The fork is already durable. Open it before surfacing a rename
          // failure so a failed cosmetic follow-up never strands the child.
          if (navigationIntent === openIntent) await open(childId)
          else await refresh()
          throw reason
        }
      }
      if (navigationIntent === openIntent) await open(childId)
      else await refresh()
    },
    configureSession: async (sessionId, configuration) => {
      const generation = ++configurationGeneration
      const previousProvider = state.configuration?.model.providerId
      await client.request<unknown>({
        type: 'session.configure',
        requestId: requestId(),
        payload: { sessionId, configuration },
      })
      if (generation !== configurationGeneration) return
      rememberComposerConfiguration(configuration)
      setState((current) => (current.activeSessionId === sessionId ? { ...current, configuration } : current))
      // Only the provider decides whether an adapter serves the selection, so
      // only its change can move `routable`. Re-read after the write: a stale
      // `false` would keep the composer inert for a selection the host now
      // serves, and a stale `true` would unlock one it no longer does.
      if (previousProvider === configuration.model.providerId) return
      await refreshSessionModelDirectory(client, setState, sessionId)
    },
    executeCommand: async (sessionId, command, attachments = []) => {
      if ((await executeCommandRequest(sessionId, command, attachments)) === 'executed') return true
      // The palette hands the picked line to the command surface; a skill row
      // has no command behind it, so the same line is submitted as the prompt
      // gesture it spells.
      await sendUserTurn(sessionId, command, attachments, 'queue', undefined)
      return true
    },
    createSession: async (workspaceId, presetId) => {
      const navigationIntent = ++openIntent
      const workspace =
        (workspaceId === undefined
          ? undefined
          : state.workspaces.find((entry) => entry.id === workspaceId)) ?? state.workspaces[0]
      const defaultConfiguration = createDefaultConfiguration(state, composerPreferences)
      const configuration =
        presetId === undefined ? defaultConfiguration : { ...defaultConfiguration, preset: presetId }
      const reusableBlank =
        presetId === undefined && workspace !== undefined
          ? findReusableBlankSession(state.sessions, state.archivedSessionIds, workspace)
          : undefined
      if (state.connectedDshVersion === DSH_RC12_VERSION && reusableBlank !== undefined) {
        await open(reusableBlank.id)
        return
      }
      const rc11ReusableBlank = state.connectedDshVersion === DSH_RC11_VERSION ? reusableBlank : undefined
      const result = await client.request<unknown>({
        type: 'session.create',
        requestId: requestId(),
        payload: {
          ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
          ...(rc11ReusableBlank === undefined
            ? {}
            : { sessionId: rc11ReusableBlank.id, reuseWorkspaceBlank: true as const }),
          configuration,
        },
      })
      const created = object(result)
      await refresh()
      if (navigationIntent === openIntent && typeof created?.id === 'string') await open(created.id)
    },
    openSkillDocument: async (sessionId, skillId) => {
      await client.request<unknown>({
        type: 'skill.openDocument',
        requestId: requestId(),
        payload: { sessionId, skillId },
      })
    },
    removeSession: async (sessionId) => {
      const wasActive = state.activeSessionId === sessionId
      const navigationIntent = openIntent
      await client.request<unknown>({
        type: 'session.archive',
        requestId: requestId(),
        payload: { sessionId, archived: true },
      })
      // Archive is a registry operation, not a destructive delete. Remove it
      // from the visible switcher immediately; the follow-up list refresh is
      // deliberately kept as a reconciliation step for other sessions.
      setState((current) => ({
        ...current,
        archivedSessionIds: uniqueStrings([...current.archivedSessionIds, sessionId]),
        sessions: current.sessions.filter((session) => session.id !== sessionId),
        archivedSessions: current.archivedSessions.filter((session) => session.id !== sessionId),
        ...(current.activeSessionId === sessionId ? clearedActiveSession(current, sessionId) : {}),
      }))
      await refresh()
      // Some rc.6 hosts publish the archive event after the list response.
      // Keep the just-archived session hidden even during that propagation
      // window; the next refresh will still be authoritative for everything
      // else.
      setState((current) => ({
        ...current,
        sessions: current.sessions.filter((session) => session.id !== sessionId),
      }))
      if (wasActive && navigationIntent === openIntent && state.activeSessionId === undefined) {
        const replacement = state.sessions[0]
        if (replacement !== undefined) await open(replacement.id)
      }
    },
    loadArchivedSessions: async () => {
      await loadArchivedSessions()
    },
    restoreSession: async (sessionId) => {
      await client.request<unknown>({
        type: 'session.archive',
        requestId: requestId(),
        payload: { sessionId, archived: false },
      })
      // The row belongs to the active surface again; drop the local archive
      // knowledge before the refresh so a concurrent list cannot keep it
      // hidden behind a stale archive set.
      setState((current) => ({
        ...current,
        archivedSessionIds: current.archivedSessionIds.filter((id) => id !== sessionId),
        archivedSessions: current.archivedSessions.filter((session) => session.id !== sessionId),
      }))
      await refresh()
    },
    deleteSession: async (sessionId) => {
      const wasActive = state.activeSessionId === sessionId
      const navigationIntent = openIntent
      await client.request<unknown>({
        type: 'session.remove',
        requestId: requestId(),
        payload: { sessionId },
      })
      setState((current) => ({
        ...current,
        sessions: current.sessions.filter((session) => session.id !== sessionId),
        archivedSessionIds: current.archivedSessionIds.filter((id) => id !== sessionId),
        archivedSessions: current.archivedSessions.filter((session) => session.id !== sessionId),
        ...(current.activeSessionId === sessionId ? clearedActiveSession(current, sessionId) : {}),
      }))
      await refresh()
      if (wasActive && navigationIntent === openIntent && state.activeSessionId === undefined) {
        const replacement = state.sessions[0]
        if (replacement !== undefined) await open(replacement.id)
      }
    },
    sendPrompt: async (sessionId, text, attachments, mode) => {
      const subagent =
        state.activeSessionId === sessionId && state.activeSubagent?.entry.id === sessionId
          ? state.activeSubagent
          : undefined
      if (subagent === undefined && parseSlashCommand(text) !== undefined) {
        // Slash commands are control-plane operations.  Sending them through
        // session.prompt turns /plan, /permission, /compact, and every plugin
        // command into a visible model request.  The official WebUI routes
        // the complete line through commands.execute instead, and that route
        // accepts the composer's image attachments.  Editor-context chips are
        // not part of the command payload; they stay attached to the composer
        // for the next message, exactly as they do on the Composer's own
        // command path.  A line DSH answers as unknown is not a command at all
        // and is submitted below as the prompt gesture it spells.
        if ((await executeCommandRequest(sessionId, text, attachments)) === 'executed') return
      }
      await sendUserTurn(sessionId, text, attachments, mode, subagent)
    },
    cancelSession: async (sessionId) => {
      const subagent =
        state.activeSessionId === sessionId && state.activeSubagent?.entry.id === sessionId
          ? state.activeSubagent
          : undefined
      if (subagent?.entry.mode === 'one-shot') throw new Error(translate('app.error.subagentInterrupt'))
      await client.request<unknown>(
        subagent === undefined
          ? { type: 'session.cancel', requestId: requestId(), payload: { sessionId } }
          : { type: 'subagent.interrupt', requestId: requestId(), payload: { sessionId } },
      )
    },
    updateGoal: async (goalId, update) => {
      if (update.title === undefined && update.status === undefined && update.maxGoalRounds === undefined)
        return
      await client.request<unknown>({
        type: 'goal.update',
        requestId: requestId(),
        payload: { goalId, ...update },
      })
      setState((current) => ({
        ...current,
        goals: current.goals.map((goal) => (goal.id === goalId ? { ...goal, ...update } : goal)),
      }))
      await refreshLiveGoals()
    },
    clearGoal: async (goalId) => {
      await client.request<unknown>({
        type: 'goal.clear',
        requestId: requestId(),
        payload: { goalId },
      })
      setState((current) => ({
        ...current,
        goals: current.goals.filter((goal) => goal.id !== goalId),
      }))
    },
    updateQueue: (inputId, text) =>
      client
        .request<unknown>({
          type: 'session.queue.update',
          requestId: requestId(),
          payload: { inputId, text },
        })
        .then(() => undefined),
    removeQueue: (inputId) =>
      client
        .request<unknown>({
          type: 'session.queue.remove',
          requestId: requestId(),
          payload: { inputId },
        })
        .then(() => undefined),
    steerQueue: (inputId) =>
      client
        .request<unknown>({
          type: 'session.queue.steer',
          requestId: requestId(),
          payload: { inputId },
        })
        .then(() => undefined),
    steerAllQueued: async () => {
      // Mirrors the official empty-draft accelerated Enter: every still-queued
      // pending input is steered FIFO into the running turn. Steer is
      // best-effort (a closed delivery window turns the item back into the
      // next waking Queue item), so failures of one row must not abort the rest.
      const targets = state.queue.filter((item) => item.mode === 'queue')
      for (const item of targets) {
        try {
          await client.request<unknown>({
            type: 'session.queue.steer',
            requestId: requestId(),
            payload: { inputId: item.id },
          })
        } catch {
          // Best-effort, matching the official queue dock semantics.
        }
      }
    },
    loadFeedback: async (sessionId) => {
      applyFeedbackSnapshot(sessionId, await requestFeedbackSnapshot(sessionId, true))
    },
    ensureFeedback: async (sessionId, messageId) => {
      const alreadyReady = feedbackReadySessions.has(sessionId) && state.activeSessionId === sessionId
      const result = await requestFeedbackSnapshot(sessionId)
      if (!alreadyReady) applyFeedbackSnapshot(sessionId, result)
      return state.activeSessionId === sessionId ? state.feedback[messageId] : undefined
    },
    toggleFeedback: async (sessionId, messageId, rating) => {
      try {
        const current = state.feedback[messageId]
        if (current?.rating === rating) {
          await client.request<unknown>({
            type: 'feedback.remove',
            requestId: requestId(),
            payload: { sessionId, messageId },
          })
          setState((next) => {
            if (next.activeSessionId !== sessionId) return next
            const feedback = { ...next.feedback }
            delete feedback[messageId]
            return { ...next, feedback }
          })
          return
        }
        const item = object(
          await client.request<unknown>({
            type: 'feedback.toggle',
            requestId: requestId(),
            payload: {
              sessionId,
              messageId,
              rating,
              ...(current?.note === undefined ? {} : { note: current.note }),
              ...(current?.category === undefined ? {} : { category: current.category }),
            },
          }),
        )
        if (!isMessageFeedbackItem(item)) throw new Error(translate('app.error.feedback'))
        setState((next) =>
          next.activeSessionId === sessionId
            ? { ...next, feedback: { ...next.feedback, [item.messageId]: item } }
            : next,
        )
      } catch (error) {
        if (!isFeedbackCapabilityUnavailable(error)) throw error
        setState((next) =>
          next.activeSessionId === sessionId ? { ...next, feedbackUnavailable: true } : next,
        )
      }
    },
    submitFeedback: async (sessionId, messageId, rating, note, category) => {
      try {
        const item = object(
          await client.request<unknown>({
            type: 'feedback.toggle',
            requestId: requestId(),
            payload: {
              sessionId,
              messageId,
              rating,
              ...(note === undefined ? {} : { note }),
              ...(category === undefined ? {} : { category }),
            },
          }),
        )
        if (!isMessageFeedbackItem(item)) throw new Error(translate('app.error.feedback'))
        setState((next) =>
          next.activeSessionId === sessionId
            ? { ...next, feedback: { ...next.feedback, [item.messageId]: item } }
            : next,
        )
      } catch (error) {
        if (!isFeedbackCapabilityUnavailable(error)) throw error
        setState((next) =>
          next.activeSessionId === sessionId ? { ...next, feedbackUnavailable: true } : next,
        )
        // A dialog submission must remain pending in the UI when the optional
        // sidecar is absent; resolving here would make MessageActions show a
        // false success acknowledgement.
        throw error
      }
    },
    setFeedbackNote: async (sessionId, messageId, note) => {
      try {
        const current = state.feedback[messageId]
        if (current === undefined) return
        const item = object(
          await client.request<unknown>({
            type: 'feedback.note',
            requestId: requestId(),
            payload: {
              sessionId,
              messageId,
              rating: current.rating,
              ...(note === undefined ? {} : { note }),
              ...(current.category === undefined ? {} : { category: current.category }),
            },
          }),
        )
        if (!isMessageFeedbackItem(item)) throw new Error(translate('app.error.feedback'))
        setState((next) =>
          next.activeSessionId === sessionId
            ? { ...next, feedback: { ...next.feedback, [item.messageId]: item } }
            : next,
        )
      } catch (error) {
        if (!isFeedbackCapabilityUnavailable(error)) throw error
        setState((next) =>
          next.activeSessionId === sessionId ? { ...next, feedbackUnavailable: true } : next,
        )
      }
    },
    removeFeedback: async (sessionId, messageId) => {
      try {
        await client.request<unknown>({
          type: 'feedback.remove',
          requestId: requestId(),
          payload: { sessionId, messageId },
        })
        setState((next) => {
          if (next.activeSessionId !== sessionId) return next
          const feedback = { ...next.feedback }
          delete feedback[messageId]
          return { ...next, feedback }
        })
      } catch (error) {
        if (!isFeedbackCapabilityUnavailable(error)) throw error
        setState((next) =>
          next.activeSessionId === sessionId ? { ...next, feedbackUnavailable: true } : next,
        )
      }
    },
    listReferences: async (sessionId, query, quoted) => {
      const result = await client.request<unknown>({
        type: 'reference.list',
        requestId: requestId(),
        payload: { sessionId, query, quoted },
      })
      return referenceCandidates(result)
    },
    respondToPermission: (interactionId, optionId) =>
      client
        .request<unknown>({
          type: 'interaction.permission.respond',
          requestId: requestId(),
          payload: { interactionId, optionId },
        })
        .then(() =>
          setState((current) => ({
            ...current,
            permissions: current.permissions.filter((item) => item.id !== interactionId),
          })),
        ),
    respondToQuestion: (questionId, response) =>
      client
        .request<unknown>({
          type: 'interaction.question.respond',
          requestId: requestId(),
          payload: {
            questionId,
            response: questionResponsePayload(response),
          },
        })
        .then(() =>
          setState((current) => ({
            ...current,
            questions: current.questions.filter((item) => item.id !== questionId),
          })),
        ),
    cancelQuestion: (questionId) =>
      client
        .request<unknown>({
          type: 'interaction.question.cancel',
          requestId: requestId(),
          payload: { questionId },
        })
        .then(() =>
          setState((current) => ({
            ...current,
            questions: current.questions.filter(
              (item) => item.id !== questionId && !item.items?.some((entry) => entry.id === questionId),
            ),
          })),
        ),
    pickAttachment: async () => {
      return attachmentFromResult(
        await client.request<unknown>({ type: 'attachment.pick', requestId: requestId() }),
      )
    },
    ingestAttachment: async (input) => {
      return attachmentFromResult(
        await client.request<unknown>({
          type: 'attachment.ingest',
          requestId: requestId(),
          payload: {
            name: input.name,
            ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
            dataBase64: input.dataBase64,
          },
        }),
      )
    },
    previewAttachment: async (uri) => {
      const result = object(
        await client.request<unknown>({
          type: 'attachment.preview',
          requestId: requestId(),
          payload: { uri },
        }),
      )
      if (result?.cancelled === true || typeof result?.dataUri !== 'string') return undefined
      return result.dataUri
    },
    readSessionAttachment: async (sessionId, image) => {
      const result = object(
        await client.request<unknown>({
          type: 'attachment.read',
          requestId: requestId(),
          payload: { sessionId, attachmentId: image.attachmentId },
        }),
      )
      if (result?.cancelled === true) return undefined
      const direct = imageDataUri(result?.dataUri)
      if (direct !== undefined) return direct
      const handle = object(result?.attachment)?.uri
      if (typeof handle !== 'string' || handle.trim() === '') return undefined
      try {
        const preview = object(
          await client.request<unknown>({
            type: 'attachment.preview',
            requestId: requestId(),
            payload: { uri: handle },
          }),
        )
        return imageDataUri(preview?.dataUri)
      } finally {
        await client
          .request<unknown>({
            type: 'attachment.release',
            requestId: requestId(),
            payload: { uris: [handle] },
          })
          .catch(() => undefined)
      }
    },
    releaseAttachments: async (uris) => {
      if (uris.length === 0) return
      await client.request<unknown>({
        type: 'attachment.release',
        requestId: requestId(),
        payload: { uris: [...uris] },
      })
    },
    captureEditorContext: async (kind, workspaceFolderId) => {
      if (typeof client.featureRequest !== 'function') throw new Error(translate('app.error.dshMode'))
      const result = object(
        await client.featureRequest<unknown>({
          type: 'editor.context.capture',
          requestId: requestId(),
          payload:
            workspaceFolderId === undefined
              ? { kind: kind === 'file' ? 'open-document' : kind }
              : { kind: kind === 'file' ? 'open-document' : kind, workspaceFolderId },
        }),
      )
      const items = result?.kind === 'editor.context' ? parseEditorContextItems(result.items) : undefined
      if (items === undefined) throw new Error(translate('app.error.dshMode'))
      const availableKinds =
        result?.kind === 'editor.context'
          ? parseEditorContextAvailableKinds(result.availableKinds)
          : undefined
      setState((current) => ({
        ...current,
        editorContext: mergeEditorContext(current.editorContext, items),
        ...(availableKinds === undefined ? {} : { editorContextAvailableKinds: availableKinds }),
      }))
    },
    refreshEditorContext: refreshEditorContextState,
    previewEditorContext: async (contextRef) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const item = state.editorContext.find((candidate) => candidate.ref.contextRef === contextRef)
      if (item === undefined) return undefined
      const result = object(
        await client.featureRequest<unknown>({
          type: 'editor.context.preview',
          requestId: requestId(),
          payload: { contextRef, workspaceFolderId: item.ref.workspaceFolderId },
        }),
      )
      if (result?.kind !== 'editor.preview' || typeof result.contextRef !== 'string') return undefined
      if (typeof result.redactedPreviewText !== 'string') return undefined
      return {
        contextRef: result.contextRef,
        text: result.redactedPreviewText,
        truncated: result.truncated === true,
        expiresAt: typeof result.expiresAt === 'number' ? result.expiresAt : 0,
      }
    },
    releaseEditorContext: async (contextRefs) => {
      if (contextRefs.length === 0 || typeof client.featureRequest !== 'function') return
      const items = [...state.editorContext]
      await releaseEditorContextRefs(contextRefs, items)
      const released = new Set(contextRefs)
      setState((current) => ({
        ...current,
        editorContext: current.editorContext.filter((item) => !released.has(item.ref.contextRef)),
      }))
    },
    refreshChanges: refreshChangesState,
    getChangeDetail: async (changeId) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const result = await client.featureRequest<unknown>({
        type: 'changes.detail',
        requestId: requestId(),
        payload: { changeId },
      })
      return parseFeatureChangeDetail(result)
    },
    markChangeReviewed: async (changeId, reviewState) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const result = await client.featureRequest<unknown>({
        type: 'changes.markReviewed',
        requestId: requestId(),
        payload: { changeId, reviewState: reviewState === 'unreviewed' ? 'viewed' : reviewState },
      })
      const changes = parseFeatureChangesResult(result)
      const change = changes?.[0]
      if (change !== undefined)
        setState((current) => ({
          ...current,
          changes: current.changes.map((entry) => (entry.changeId === change.changeId ? change : entry)),
        }))
      return change
    },
    openChange: async (changeId) => {
      if (typeof client.featureRequest !== 'function') return
      const change = state.changes.find((entry) => entry.changeId === changeId)
      if (change === undefined) return
      const location = change.locations[0]
      await client.featureRequest<unknown>({
        type: 'navigation.open',
        requestId: requestId(),
        payload: {
          workspaceFolderId: change.workspaceFolderId,
          relativePath: change.relativePath,
          reveal: 'focus',
          ...(location?.line === undefined
            ? {}
            : {
                range: {
                  start: { line: location.line, column: 0 },
                  end: { line: location.line, column: 0 },
                },
              }),
        },
      })
    },
    refreshTasks: refreshTasksState,
    getTask: async (taskId) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const result = await client.featureRequest<unknown>({
        type: 'tasks.open',
        requestId: requestId(),
        payload: { taskId },
      })
      return parseFeatureTasksResult(result)?.items[0]
    },
    stopTask: async (taskId, taskRevision) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const result = await client.featureRequest<unknown>({
        type: 'tasks.stop',
        requestId: requestId(),
        payload: { taskId, taskRevision },
      })
      const task = parseFeatureTasksResult(result)?.items[0]
      if (task !== undefined)
        setState((current) => ({
          ...current,
          tasks: mergeTask(current.tasks, task),
        }))
      return task
    },
    answerTask: async (taskId, interactionId, answer) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const result = await client.featureRequest<unknown>({
        type: 'tasks.answer',
        requestId: requestId(),
        payload: { taskId, interactionId, answer },
      })
      const task = parseFeatureTasksResult(result)?.items[0]
      if (task !== undefined)
        setState((current) => ({
          ...current,
          tasks: mergeTask(current.tasks, task),
        }))
      return task
    },
    refreshCheckpoints: refreshCheckpointsState,
    createCheckpoint: async (label) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const sessionId = state.activeSessionId
      if (sessionId === undefined) return undefined
      const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
      if (workspaceFolderId === undefined) return undefined
      const normalizedLabel = label?.trim()
      const result = await client.featureRequest<unknown>({
        type: 'checkpoint.create',
        requestId: requestId(),
        payload: {
          sessionId,
          workspaceFolderId,
          ...(normalizedLabel === undefined || normalizedLabel === '' ? {} : { label: normalizedLabel }),
        },
      })
      const checkpoint = parseFeatureCheckpointsResult(result)?.[0]
      if (checkpoint === undefined) throw new Error(translate('app.error.checkpoint'))
      setState((current) =>
        current.activeSessionId !== sessionId
          ? current
          : {
              ...current,
              checkpoints: [
                checkpoint,
                ...current.checkpoints.filter((entry) => entry.checkpointId !== checkpoint.checkpointId),
              ],
            },
      )
      return checkpoint
    },
    previewCheckpoint: async (checkpointId) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const sessionId = state.activeSessionId
      if (sessionId === undefined) return undefined
      const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
      if (workspaceFolderId === undefined) return undefined
      const result = await client.featureRequest<unknown>({
        type: 'checkpoint.preview',
        requestId: requestId(),
        payload: { checkpointId, sessionId, workspaceFolderId },
      })
      return parseFeatureCheckpointPreviewResult(result)
    },
    deleteCheckpoint: async (checkpointId) => {
      if (typeof client.featureRequest !== 'function') return
      const sessionId = state.activeSessionId
      if (sessionId === undefined) return
      const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
      if (workspaceFolderId === undefined) return
      const result = await client.featureRequest<unknown>({
        type: 'checkpoint.delete',
        requestId: requestId(),
        payload: { checkpointId, sessionId, workspaceFolderId },
      })
      const deleted = parseFeatureCheckpointsResult(result)?.[0]
      if (deleted === undefined) throw new Error(translate('app.error.checkpoint'))
      setState((current) => ({
        ...current,
        checkpoints: current.checkpoints.filter((entry) => entry.checkpointId !== checkpointId),
      }))
    },
    restoreCheckpoint: async (checkpointId, conflictPolicy) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const sessionId = state.activeSessionId
      if (sessionId === undefined) return undefined
      const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
      if (workspaceFolderId === undefined) return undefined
      const checkpoint = state.checkpoints.find((entry) => entry.checkpointId === checkpointId)
      if (checkpoint?.expectedRevision === undefined) throw new Error(translate('app.error.checkpoint'))
      const result = await client.featureRequest<unknown>({
        type: 'checkpoint.restore',
        requestId: requestId(),
        payload: {
          checkpointId,
          sessionId,
          workspaceFolderId,
          expectedCurrentRevision: checkpoint.expectedRevision,
          conflictPolicy,
        },
      })
      const operation = parseFeatureOperationResult(result)
      if (operation === undefined) throw new Error(translate('app.error.checkpoint'))
      await refreshCheckpointsState(sessionId)
      return operation.state === 'completed' || operation.state === 'partial' ? operation.state : undefined
    },
    refreshPromptTemplates: refreshPromptTemplatesState,
    readPromptTemplate: async (templateId) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const sessionId = state.activeSessionId
      if (sessionId === undefined) return undefined
      const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
      if (workspaceFolderId === undefined) return undefined
      const result = await client.featureRequest<unknown>({
        type: 'prompt.template.read',
        requestId: requestId(),
        payload: { templateId, sessionId, workspaceFolderId },
      })
      return parseFeaturePromptTemplateResult(result)
    },
    insertPromptTemplate: async (templateId, variables) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const sessionId = state.activeSessionId
      if (sessionId === undefined) return undefined
      const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
      if (workspaceFolderId === undefined) return undefined
      const result = await client.featureRequest<unknown>({
        type: 'prompt.template.insert',
        requestId: requestId(),
        payload: {
          templateId,
          sessionId,
          workspaceFolderId,
          ...(variables === undefined ? {} : { variables }),
        },
      })
      return parseFeaturePromptTemplateInsertionResult(result)
    },
    createPromptTemplate: async (draft) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const sessionId = state.activeSessionId
      if (sessionId === undefined) return undefined
      const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
      if (workspaceFolderId === undefined) return undefined
      const result = await client.featureRequest<unknown>({
        type: 'prompt.template.create',
        requestId: requestId(),
        payload: {
          ...draft,
          sessionId,
          workspaceFolderId,
          variables: promptTemplateVariables(draft.variables),
        },
      })
      const template = parseFeaturePromptTemplatesResult(result)?.[0]
      if (template === undefined) throw new Error(translate('app.error.promptTemplate'))
      setState((current) => ({
        ...current,
        promptTemplates: [
          template,
          ...current.promptTemplates.filter((entry) => entry.templateId !== template.templateId),
        ],
      }))
      return template
    },
    updatePromptTemplate: async (templateId, patch) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const sessionId = state.activeSessionId
      if (sessionId === undefined) return undefined
      const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
      if (workspaceFolderId === undefined) return undefined
      const result = await client.featureRequest<unknown>({
        type: 'prompt.template.update',
        requestId: requestId(),
        payload: {
          templateId,
          sessionId,
          workspaceFolderId,
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          ...(patch.templateText === undefined ? {} : { templateText: patch.templateText }),
          ...(patch.variables === undefined ? {} : { variables: promptTemplateVariables(patch.variables) }),
        },
      })
      const template = parseFeaturePromptTemplatesResult(result)?.[0]
      if (template === undefined) throw new Error(translate('app.error.promptTemplate'))
      setState((current) => ({
        ...current,
        promptTemplates: [
          template,
          ...current.promptTemplates.filter((entry) => entry.templateId !== template.templateId),
        ],
      }))
      return template
    },
    deletePromptTemplate: async (templateId) => {
      if (typeof client.featureRequest !== 'function') return
      const sessionId = state.activeSessionId
      if (sessionId === undefined) return
      const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
      if (workspaceFolderId === undefined) return
      const result = await client.featureRequest<unknown>({
        type: 'prompt.template.delete',
        requestId: requestId(),
        payload: { templateId, sessionId, workspaceFolderId },
      })
      if (parseFeatureOperationResult(result) === undefined)
        throw new Error(translate('app.error.promptTemplate'))
      setState((current) => ({
        ...current,
        promptTemplates: current.promptTemplates.filter((entry) => entry.templateId !== templateId),
      }))
    },
    setPromptMode: async (mode) => {
      const sessionId = state.activeSessionId
      const configuration = state.configuration
      if (sessionId === undefined || configuration === undefined) return false
      // The command directory is advisory for session visibility, but it is
      // authoritative for exposing the semantic Plan toggle. If the user
      // reaches this action before the background directory read completes,
      // join that in-flight read instead of treating a temporary empty list
      // as an unsupported upstream capability.
      if (mode === 'plan' && !hasDynamicCommand(state.commands, 'plan')) await refreshCommands(sessionId)
      const resolution = resolvePromptMode(mode, {
        planCommandAvailable: hasDynamicCommand(state.commands, 'plan'),
      })
      if (!resolution.supported) throw new Error(resolution.reason ?? translate('app.error.promptMode'))
      if (resolution.planEnabled !== configuration.planMode)
        await executeCommandRequest(sessionId, resolution.planEnabled ? '/plan' : '/plan off')
      if (state.activeSessionId !== sessionId) return false
      setState((current) =>
        current.activeSessionId === sessionId ? { ...current, promptMode: mode } : current,
      )
      composerPreferences = { ...composerPreferences, promptMode: mode }
      persistWebviewState()
      return true
    },
    listOpenFiles: async () => {
      return openFileCandidatesFromResult(
        await client.request<unknown>({ type: 'attachment.open.list', requestId: requestId() }),
      )
    },
    attachOpenFile: async (candidateId) => {
      return attachmentFromResult(
        await client.request<unknown>({
          type: 'attachment.open.attach',
          requestId: requestId(),
          payload: { candidateId },
        }),
      )
    },
    rememberOpenFile: (candidateId) => {
      const normalized = candidateId.trim()
      if (normalized === '') return
      composerPreferences = { ...composerPreferences, openFileId: normalized }
      setState((current) => ({ ...current, preferredOpenFileId: normalized }))
      persistWebviewState()
    },
    openLink: async (href) => {
      const result = object(
        await client.request<unknown>({
          type: 'view.openLink',
          requestId: requestId(),
          payload: { href },
        }),
      )
      if (result?.opened === true) return
      throw new Error(typeof result?.message === 'string' ? result.message : translate('app.error.openLink'))
    },
    showInFolder: async (href) => {
      const result = object(
        await client.request<unknown>({
          type: 'view.showInFolder',
          requestId: requestId(),
          payload: { href },
        }),
      )
      if (result?.opened === true) return
      throw new Error(typeof result?.message === 'string' ? result.message : translate('app.error.openLink'))
    },
    runtimeAction: (action) =>
      client
        .request<unknown>({ type: 'runtime.action', requestId: requestId(), payload: { action } })
        .then(() => undefined),
    configureConnection: async (mode, endpoint) => {
      await client.request<unknown>({
        type: 'connection.configure',
        requestId: requestId(),
        payload: { mode, ...(endpoint === undefined ? {} : { endpoint }) },
      })
    },
    checkDshUpdates,
    installDshVersion,
    readSettings: async () => {
      return parseExtensionSettings(
        await client.request<unknown>({ type: 'extensionSettings.read', requestId: requestId() }),
      )
    },
    readDshSettings: async () => {
      const snapshot = parseDshSettingsSnapshot(
        await client.request<unknown>({ type: 'settings.read', requestId: requestId() }),
      )
      if (snapshot !== undefined) applyBusyEnter(snapshot.values)
      return snapshot
    },
    openDshSettingsDocument: async () => {
      await client.request<unknown>({ type: 'settings.openDocument', requestId: requestId() })
    },
    updateDshSetting: async (path, value) => {
      await client.request<unknown>({
        type: 'settings.update',
        requestId: requestId(),
        payload: { path, value },
      })
    },
    unsetDshSetting: async (path) => {
      await client.request<unknown>({
        type: 'settings.unset',
        requestId: requestId(),
        payload: { path },
      })
    },
    createCustomProvider: async (draft) => {
      const result = parseCustomProviderCreateResult(
        await client.request<unknown>({
          type: 'provider.custom.create',
          requestId: requestId(),
          payload: {
            ...draft,
            collectionPath: [...draft.collectionPath],
            models: draft.models.map((model) => ({ ...model })),
          },
        }),
      )
      if (result === undefined) throw new Error(translate('settings.providerCreateMalformed'))
      return result
    },
    configureProviderSecret: async (providerId, field) => {
      const result = object(
        await client.request<unknown>({
          type: 'provider.secret.configure',
          requestId: requestId(),
          payload: { providerId, field },
        }),
      )
      return result?.configured === true
    },
    removeProviderSecret: async (providerId, field) => {
      await client.request<unknown>({
        type: 'provider.secret.remove',
        requestId: requestId(),
        payload: { providerId, field },
      })
    },
    configurePluginCredential: async (ref) => {
      const result = object(
        await client.request<unknown>({
          type: 'plugin.credential.configure',
          requestId: requestId(),
          payload: { ref },
        }),
      )
      return result?.configured === true
    },
    removePluginCredential: async (ref) => {
      await client.request<unknown>({
        type: 'plugin.credential.remove',
        requestId: requestId(),
        payload: { ref },
      })
    },
    refreshModelCatalog: async () => {
      await refreshProvidersAndModels(client, setState)
    },
    discoverModels: async (input) => {
      const value = await client.request<unknown>({
        type: 'models.discover',
        requestId: requestId(),
        payload: input,
      })
      const models = parseDiscoveredModels(value)
      if (models === undefined) throw new Error(translate('settings.discoveryMalformed'))
      return models
    },
    discoverCustomProviderModels: async (input) => {
      const value = await client.request<unknown>({
        type: 'models.discover.custom',
        requestId: requestId(),
        payload: input,
      })
      const models = parseDiscoveredModels(value)
      if (models === undefined) throw new Error(translate('settings.discoveryMalformed'))
      return models
    },
    loadPresetRoster: async () => {
      const roster = parsePresetRoster(
        await client.request<unknown>({ type: 'preset.list', requestId: requestId() }),
      )
      if (roster !== undefined)
        setState((current) => {
          const presets = arraysEqual(current.presets, roster.presets) ? current.presets : roster.presets
          if (presets === current.presets && current.presetSelectionEnabled === roster.modeSelectionEnabled)
            return current
          return withPresetSelectionEnabled({ ...current, presets }, roster.modeSelectionEnabled)
        })
      return roster
    },
    readPresetDocument: async (presetId) => {
      const result = object(
        await client.request<unknown>({
          type: 'preset.read',
          requestId: requestId(),
          payload: { presetId },
        }),
      )
      if (result === undefined) return undefined
      if (
        typeof result.id !== 'string' ||
        (result.trust !== 'system' && result.trust !== 'user') ||
        typeof result.content !== 'string'
      )
        return undefined
      return {
        id: result.id,
        trust: result.trust,
        content: result.content,
        ...(typeof result.name === 'string' ? { name: result.name } : {}),
        ...(typeof result.description === 'string' ? { description: result.description } : {}),
      }
    },
    copyPreset: async (from, presetId, name) => {
      // The extension route resolves with the created preset id as a bare string.
      const created = await client.request<unknown>({
        type: 'preset.copy',
        requestId: requestId(),
        payload: {
          from,
          presetId,
          ...(name === undefined || name.trim() === '' ? {} : { name: name.trim() }),
        },
      })
      return typeof created === 'string' && created !== '' ? created : undefined
    },
    removePreset: async (presetId) => {
      await client.request<unknown>({
        type: 'preset.remove',
        requestId: requestId(),
        payload: { presetId },
      })
    },
    openPresetDocument: async (presetId) => {
      const result = object(
        await client.request<unknown>({
          type: 'preset.openDocument',
          requestId: requestId(),
          payload: { presetId },
        }),
      )
      if (result === undefined) return undefined
      if (result.opened === true) return { opened: true }
      if (typeof result.path === 'string') return { opened: false, path: result.path }
      return { opened: false }
    },
    loadPluginInventory: async () =>
      parsePluginInventory(
        await client.request<unknown>({ type: 'plugin.inventory', requestId: requestId() }),
      ),
    followJob: async (jobId) => {
      const sessionId = state.activeSessionId
      const job = state.jobs.find((entry) => entry.id === jobId)
      if (sessionId === undefined || job === undefined || !state.jobControllerAvailable) return
      const prior = state.jobFollow
      if (prior !== undefined && prior.jobId !== jobId) {
        await client
          .request<unknown>({
            type: 'job.follow.stop',
            requestId: requestId(),
            payload: { sessionId, jobId: prior.jobId },
          })
          .catch(() => undefined)
      }
      const from = prior?.jobId === jobId ? prior.next : (job.output?.earliest ?? 0)
      const generation = ++jobFollowGeneration
      setState((current) => {
        const existing = current.jobFollow?.jobId === jobId ? current.jobFollow : undefined
        return {
          ...current,
          jobFollow: {
            ...(existing ?? { jobId, next: from, chunks: [], lossy: false, job }),
            jobId,
            next: Math.max(existing?.next ?? from, from),
            generation,
            awaitingOpenFrom: from,
            job: existing?.job ?? job,
          },
        }
      })
      try {
        await client.request<unknown>({
          type: 'job.follow.start',
          requestId: requestId(),
          payload: { sessionId, jobId, from },
        })
      } catch (error) {
        setState((current) =>
          current.jobFollow?.generation === generation ? { ...current, jobFollow: undefined } : current,
        )
        throw error
      }
    },
    stopFollowingJob: async () => {
      const sessionId = state.activeSessionId
      const following = state.jobFollow
      jobFollowGeneration += 1
      setState((current) => ({ ...current, jobFollow: undefined }))
      if (sessionId === undefined || following === undefined) return
      await client.request<unknown>({
        type: 'job.follow.stop',
        requestId: requestId(),
        payload: { sessionId, jobId: following.jobId },
      })
    },
    killJob: async (jobId) => {
      const sessionId = state.activeSessionId
      if (sessionId === undefined || !state.jobControllerAvailable)
        throw new Error(translate('jobs.unavailable'))
      const result = object(
        await client.request<unknown>({
          type: 'job.kill',
          requestId: requestId(),
          payload: { sessionId, jobId },
        }),
      )
      if (result?.outcome !== 'requested' && result?.outcome !== 'already-finished')
        throw new Error(translate('jobs.killFailed'))
      const rows = await safeList<JobView>(
        client,
        { type: 'job.list', requestId: requestId(), payload: { sessionId } },
        isJobView,
      )
      if (rows !== undefined)
        setState((current) => (current.activeSessionId === sessionId ? { ...current, jobs: rows } : current))
      return result.outcome
    },
    exportSession: async (options) => {
      // The host resolves `{ cancelled: true }` when the user closes the save
      // dialog; that is a successful no-op, not an error.
      await client.request<unknown>({
        type: 'session.export',
        requestId: requestId(),
        payload: {
          sessionId: options.sessionId,
          format: options.format,
          includeAttachments: options.includeAttachments,
          includeReasoning: options.includeReasoning,
        },
      })
    },
    loadSubagentChildren: async (sessionId) => {
      const catalog = await loadSubagentCatalog(sessionId)
      if (catalog !== undefined)
        setState((current) =>
          current.activeSessionId === sessionId ? { ...current, subagents: catalog } : current,
        )
      return catalog
    },
    setDrawer: (drawer) => {
      const openingSessionsDrawer = drawer === 'sessions' && state.drawer !== 'sessions'
      setState((current) => ({ ...current, drawer }))
      persistWebviewState()
      if (openingSessionsDrawer) void refresh()
    },
    dispose: () => {
      if (notifyTimer !== undefined) {
        window.clearTimeout(notifyTimer)
        notifyTimer = undefined
      }
      if (ledgerRebuildTimer !== undefined) {
        window.clearTimeout(ledgerRebuildTimer)
        ledgerRebuildTimer = undefined
      }
      // In-flight opens, rebuilds and gap backfills all guard on openVersion;
      // bumping it retires them without letting a late continuation touch a
      // disposed store. Gap backfills also read `disposed`: they outlive a
      // superseded open on purpose so their announced range is not lost.
      disposed = true
      openVersion += 1
      gapBackfills.clear()
      unhealedGapRanges.clear()
      coveredHistoryRanges.clear()
      rememberedHostOnlyNodes.clear()
      pendingHistory = []
      pendingHistorySessionId = undefined
      invalidateFeedback()
      unsubscribe()
      unsubscribeFeature()
      client.dispose()
      listeners.clear()
    },
  }
}

async function refreshProvidersAndModels(client: ProtocolClient, setState: StateSetter): Promise<void> {
  const [providersResult, modelsResult] = await Promise.allSettled([
    client.request<unknown>({ type: 'providers.list', requestId: requestId() }),
    client.request<unknown>({ type: 'models.list', requestId: requestId(), payload: {} }),
  ])
  const providers =
    providersResult.status === 'fulfilled'
      ? listValues(providersResult.value).filter(isModelProvider)
      : undefined
  const models =
    modelsResult.status === 'fulfilled' ? strictListValues(modelsResult.value, isModelDescriptor) : undefined
  setState((current) => {
    const nextProviders =
      providers === undefined || sameModelProviderList(current.providers, providers)
        ? current.providers
        : providers
    const nextModels =
      models === undefined || sameModelDescriptorList(current.models, models) ? current.models : models
    if (nextProviders === current.providers && nextModels === current.models) return current
    return { ...current, providers: nextProviders, models: nextModels }
  })
}

function parseExtensionSettings(value: unknown): ExtensionSettingsSummary | undefined {
  const settings = object(value)
  const extensionVersion = settings?.extensionVersion
  const connection = object(settings?.connection)
  const runtime = object(settings?.runtime)
  const security = object(settings?.security)
  const defaultAgent = object(settings?.defaultAgent)
  if (
    typeof extensionVersion !== 'string' ||
    extensionVersion.length === 0 ||
    extensionVersion.length > 128 ||
    connection === undefined ||
    runtime === undefined ||
    security === undefined ||
    (connection.mode !== 'auto' &&
      connection.mode !== 'custom' &&
      connection.mode !== 'attach-only' &&
      connection.mode !== 'new-isolated') ||
    typeof connection.customEndpointConfigured !== 'boolean' ||
    typeof runtime.customExecutableConfigured !== 'boolean' ||
    typeof runtime.autoStart !== 'boolean' ||
    !isPermissionPreset(security.defaultPermissionPreset) ||
    !isAgentConfiguration(defaultAgent)
  )
    return undefined
  return {
    extensionVersion,
    connection: {
      mode: connection.mode,
      customEndpointConfigured: connection.customEndpointConfigured,
    },
    runtime: {
      customExecutableConfigured: runtime.customExecutableConfigured,
      autoStart: runtime.autoStart,
    },
    security: {
      defaultPermissionPreset: security.defaultPermissionPreset,
    },
    defaultAgent: {
      preset: defaultAgent.preset,
      toolMode: defaultAgent.toolMode,
      permissionPreset: defaultAgent.permissionPreset,
      planMode: defaultAgent.planMode,
      ...(defaultAgent.sandboxMode === undefined ? {} : { sandboxMode: defaultAgent.sandboxMode }),
      ...(defaultAgent.approvalPolicy === undefined ? {} : { approvalPolicy: defaultAgent.approvalPolicy }),
      model: {
        providerId: defaultAgent.model.providerId,
        modelId: defaultAgent.model.modelId,
        ...(defaultAgent.model.reasoningLevel === undefined
          ? {}
          : { reasoningLevel: defaultAgent.model.reasoningLevel }),
      },
    },
  }
}

function parseDshUpdateSnapshot(value: unknown): DshUpdateSnapshot | undefined {
  const snapshot = object(value)
  if (
    snapshot === undefined ||
    (snapshot.status !== 'ready' && snapshot.status !== 'unavailable') ||
    !Array.isArray(snapshot.availableVersions) ||
    !snapshot.availableVersions.every(
      (entry): entry is string => typeof entry === 'string' && entry.length <= 128,
    ) ||
    typeof snapshot.updateAvailable !== 'boolean' ||
    typeof snapshot.checkedAt !== 'string'
  )
    return undefined
  const optionalString = (key: string): string | undefined => {
    const entry = snapshot[key]
    return entry === undefined ? undefined : typeof entry === 'string' ? entry : undefined
  }
  const currentSource = optionalString('currentSource')
  const currentVersion = optionalString('currentVersion')
  const globalVersion = optionalString('globalVersion')
  const latestVersion = optionalString('latestVersion')
  const latestTagVersion = optionalString('latestTagVersion')
  const nextTagVersion = optionalString('nextTagVersion')
  const failure = optionalString('failure')
  if (
    currentSource !== undefined &&
    currentSource !== 'configured' &&
    currentSource !== 'path' &&
    currentSource !== 'npm-global' &&
    currentSource !== 'bundled'
  )
    return undefined
  if (
    failure !== undefined &&
    failure !== 'npm-not-found' &&
    failure !== 'registry-unavailable' &&
    failure !== 'invalid-response'
  )
    return undefined
  const restartRequired = snapshot.restartRequired
  if (restartRequired !== undefined && typeof restartRequired !== 'boolean') return undefined
  return {
    status: snapshot.status,
    ...(currentVersion === undefined ? {} : { currentVersion }),
    ...(currentSource === undefined ? {} : { currentSource }),
    ...(globalVersion === undefined ? {} : { globalVersion }),
    ...(latestVersion === undefined ? {} : { latestVersion }),
    ...(latestTagVersion === undefined ? {} : { latestTagVersion }),
    ...(nextTagVersion === undefined ? {} : { nextTagVersion }),
    availableVersions: snapshot.availableVersions,
    updateAvailable: snapshot.updateAvailable,
    checkedAt: snapshot.checkedAt,
    ...(failure === undefined ? {} : { failure }),
    ...(restartRequired === true ? { restartRequired: true } : {}),
  }
}

function parseDshUpdateProgress(value: unknown): DshRuntimeUpdateProgress | undefined {
  const progress = object(value)
  if (progress === undefined) return undefined
  const phase = progress.phase
  if (
    phase !== 'checking' &&
    phase !== 'downloading' &&
    phase !== 'installing' &&
    phase !== 'verifying' &&
    phase !== 'completed' &&
    phase !== 'failed'
  )
    return undefined
  const version = progress.version
  if (version !== undefined && (typeof version !== 'string' || version.length === 0 || version.length > 128))
    return undefined
  return {
    phase,
    ...(version === undefined ? {} : { version }),
  }
}

function parseFeatureCapabilityProfile(value: unknown): FeatureCapabilityProfile | undefined {
  const profile = object(value)
  const capabilities = object(profile?.capabilities)
  if (
    profile === undefined ||
    capabilities === undefined ||
    typeof profile.dshVersion !== 'string' ||
    typeof profile.protocolVersion !== 'string' ||
    (profile.source !== 'pinned-adapter' && profile.source !== 'compatibility-fallback')
  )
    return undefined
  const parsed: Record<
    string,
    FeatureCapabilityProfile['capabilities'][keyof FeatureCapabilityProfile['capabilities']]
  > = {}
  for (const id of FEATURE_CAPABILITY_IDS) {
    const capability = object(capabilities[id])
    if (
      capability === undefined ||
      !['verified-contract', 'compatibility-fallback', 'unavailable'].includes(String(capability.state)) ||
      !['verified-contract', 'compatibility-fallback', 'unavailable', 'not-applicable'].includes(
        String(capability.upstream),
      )
    )
      return undefined
    parsed[id] = {
      state: capability.state as FeatureCapabilityProfile['capabilities'][typeof id]['state'],
      upstream: capability.upstream as FeatureCapabilityProfile['capabilities'][typeof id]['upstream'],
      ...(typeof capability.reason === 'string' ? { reason: capability.reason.slice(0, 512) } : {}),
    }
  }
  return {
    dshVersion: profile.dshVersion.slice(0, 128),
    protocolVersion: profile.protocolVersion.slice(0, 128),
    source: profile.source,
    capabilities: parsed as FeatureCapabilityProfile['capabilities'],
  }
}

function parseDshSettingsSnapshot(value: unknown): DshSettingsSnapshot | undefined {
  const settings = object(value)
  const schema = object(settings?.schema)
  if (
    schema === undefined ||
    typeof schema.version !== 'string' ||
    typeof schema.writable !== 'boolean' ||
    typeof schema.hasDocument !== 'boolean' ||
    !Array.isArray(schema.fields) ||
    !schema.fields.every(isSettingsField) ||
    !Array.isArray(schema.namespaces) ||
    !schema.namespaces.every(isSettingsNamespace)
  )
    return undefined
  const values = object(settings?.values)
  if (values === undefined) return undefined
  return {
    schema: {
      version: schema.version,
      writable: schema.writable,
      hasDocument: schema.hasDocument,
      fields: schema.fields,
      namespaces: schema.namespaces,
    },
    values,
  }
}

function isSettingsNamespace(value: unknown): value is DshSettingsSchema['namespaces'][number] {
  const namespace = object(value)
  return (
    namespace !== undefined &&
    typeof namespace.ns === 'string' &&
    (namespace.applies === 'live' || namespace.applies === 'restart') &&
    Number.isSafeInteger(namespace.revision) &&
    (namespace.revision as number) >= 0 &&
    Array.isArray(namespace.userFields) &&
    namespace.userFields.every((field) => typeof field === 'string') &&
    Array.isArray(namespace.secrets) &&
    namespace.secrets.every(
      (secret) =>
        object(secret) !== undefined &&
        typeof object(secret)?.field === 'string' &&
        typeof object(secret)?.set === 'boolean',
    )
  )
}

function isSettingsField(value: unknown): value is DshSettingsSchema['fields'][number] {
  const field = object(value)
  return (
    field !== undefined &&
    typeof field.path === 'string' &&
    typeof field.label === 'string' &&
    typeof field.required === 'boolean' &&
    typeof field.restartRequired === 'boolean' &&
    (field.enumValues === undefined ||
      (Array.isArray(field.enumValues) && field.enumValues.every((entry) => typeof entry === 'string'))) &&
    (field.type === 'string' ||
      field.type === 'number' ||
      field.type === 'boolean' ||
      field.type === 'enum' ||
      field.type === 'secret' ||
      field.type === 'object' ||
      field.type === 'array')
  )
}

async function refreshSessions(
  client: ProtocolClient,
  setState: StateSetter,
  isCurrent: () => boolean = () => true,
  awaitCatalogs = true,
): Promise<void> {
  const criticalResults = Promise.allSettled([
    client.request<unknown>({
      type: 'session.list',
      requestId: requestId(),
      payload: { archived: false },
    }),
    client.request<unknown>({ type: 'workspace.list', requestId: requestId() }),
  ])
  const catalogResults = Promise.allSettled([
    client.request<unknown>({ type: 'providers.list', requestId: requestId() }),
    client.request<unknown>({ type: 'models.list', requestId: requestId(), payload: {} }),
    client.request<unknown>({ type: 'preset.list', requestId: requestId() }),
  ])
  const [sessionResult, workspaceResult] = await criticalResults
  const value = (result: PromiseSettledResult<unknown>): unknown =>
    result.status === 'fulfilled' ? result.value : undefined
  const sessionItems = object(value(sessionResult))?.items
  const workspacePayload = object(value(workspaceResult))
  const archivedFromHost = stringList(workspacePayload?.archivedSessionIds)
  const rawSessions = strictListValues(sessionItems, isSessionSummary)
  const rawWorkspaces =
    workspaceResult.status === 'fulfilled'
      ? strictListValues(value(workspaceResult), isWorkspaceSummary)
      : undefined
  if (!isCurrent()) return
  setState((current) => {
    // Keep local archive knowledge monotonic while the host publishes the
    // archive-set echo. This prevents a stale concurrent session.list from
    // reintroducing the row that was just archived.
    const archivedSessionIds = mergeUniqueStrings(current.archivedSessionIds, archivedFromHost ?? [])
    const archived = new Set(archivedSessionIds)
    const sessions =
      rawSessions === undefined
        ? undefined
        : deduplicateSessionSummaries(rawSessions.filter((session) => !archived.has(session.id)))
    const listedSessions =
      sessions ?? deduplicateSessionSummaries(current.sessions.filter((session) => !archived.has(session.id)))
    // A DSH workspace attach and its session.list projection can commit in
    // adjacent turns. Do not discard the active conversation merely because a
    // refresh observed that short window without its row. The authoritative
    // archive set is the only refresh result that is allowed to remove it.
    const activeSession =
      current.activeSessionId === undefined
        ? undefined
        : current.sessions.find((session) => session.id === current.activeSessionId)
    const nextSessions = deduplicateSessionSummaries(
      activeSession !== undefined &&
        !archived.has(activeSession.id) &&
        !listedSessions.some((session) => session.id === activeSession.id)
        ? [...listedSessions, activeSession]
        : listedSessions,
    )
    const stableSessions = sameSessionSummaryList(current.sessions, nextSessions)
      ? current.sessions
      : nextSessions
    const stableWorkspaces =
      rawWorkspaces === undefined
        ? current.workspaces
        : sameWorkspaceSummaryList(current.workspaces, rawWorkspaces)
          ? current.workspaces
          : rawWorkspaces
    const activeSessionIsArchived =
      current.activeSessionId !== undefined && archived.has(current.activeSessionId)
    const hasVisibilitySnapshot = rawSessions !== undefined || archivedFromHost !== undefined
    if (
      stableSessions === current.sessions &&
      archivedSessionIds === current.archivedSessionIds &&
      stableWorkspaces === current.workspaces &&
      !(hasVisibilitySnapshot && activeSessionIsArchived)
    )
      return current
    return {
      ...current,
      sessions: stableSessions,
      archivedSessionIds,
      // A transient workspace.list failure must not turn a known temporary
      // workspace into an apparently successful empty snapshot. The host is
      // responsible for creating/restoring the no-folder workspace; retaining
      // the last good value keeps the UI stable until that retry succeeds.
      workspaces: stableWorkspaces,
      ...(hasVisibilitySnapshot && activeSessionIsArchived
        ? {
            activeSessionId: undefined,
            timeline: {
              sessionId: undefined,
              nodes: [],
              lastSequence: -1,
              nodeChangeStart: 0,
              eventCount: 0,
            },
            history: [],
            historyHasMore: false,
            historyBeforeSequence: undefined,
            historyLoading: false,
            projections: {},
            configuration: undefined,
            sessionModels: [],
            sessionModelFailures: [],
            sessionModelCurrent: undefined,
            sessionModelRoutable: undefined,
            sessionModelDirectoryLoading: false,
            sessionModelDirectoryError: undefined,
            permissionPresets: [],
            queue: [],
            goals: [],
            todos: [],
            jobs: [],
            jobFollow: undefined,
            feedback: {},
            feedbackUnavailable: false,
            subagents: EMPTY_SUBAGENT_CATALOG,
            activeSubagent: undefined,
            commands: [],
          }
        : {}),
    }
  })
  const applyCatalogs = (results: readonly PromiseSettledResult<unknown>[]): void => {
    if (!isCurrent()) return
    const catalogValue = (index: number): unknown => {
      const result = results[index]
      return result?.status === 'fulfilled' ? result.value : undefined
    }
    const providers = listValues(catalogValue(0)).filter(isModelProvider)
    const models = strictListValues(catalogValue(1), isModelDescriptor)
    const presetRoster = parsePresetRoster(catalogValue(2))
    const presets = presetRoster?.presets
    setState((current) => {
      const nextProviders =
        providers === undefined || sameModelProviderList(current.providers, providers)
          ? current.providers
          : providers
      const nextModels =
        models === undefined || sameModelDescriptorList(current.models, models) ? current.models : models
      const nextPresets =
        presets === undefined || samePresetDescriptorList(current.presets, presets)
          ? current.presets
          : presets
      const nextPresetSelectionEnabled =
        presetRoster === undefined ? current.presetSelectionEnabled : presetRoster.modeSelectionEnabled
      if (
        nextProviders === current.providers &&
        nextModels === current.models &&
        nextPresets === current.presets &&
        nextPresetSelectionEnabled === current.presetSelectionEnabled
      )
        return current
      return withPresetSelectionEnabled(
        {
          ...current,
          providers: nextProviders,
          models: nextModels,
          presets: nextPresets,
        },
        nextPresetSelectionEnabled,
      )
    })
  }
  if (awaitCatalogs) applyCatalogs(await catalogResults)
  else void catalogResults.then(applyCatalogs)
}

/**
 * Restore the last explicit session when possible. A fresh Webview can lose
 * its persisted id while the DSH session registry is already populated, so
 * fall back to the most recent active root session and then the most recent
 * non-blank root session instead of presenting a misleading "new session"
 * posture. The workspace membership list is also an intentional fallback:
 * during an attach, workspace.list can know a durable session before the
 * session.list projection includes its summary.
 */
function selectStartupSessionId(
  sessions: readonly SessionSummary[],
  workspaces: readonly WorkspaceSummary[],
  archivedSessionIds: readonly string[],
  rememberedSessionId: string | undefined,
): string | undefined {
  const archived = new Set(archivedSessionIds)
  const workspaceSessionIds = workspaces
    .flatMap((workspace) => workspace.sessionIds ?? [])
    .filter((sessionId, index, all) => !archived.has(sessionId) && all.indexOf(sessionId) === index)
  const remembered =
    rememberedSessionId === undefined
      ? undefined
      : sessions.some((session) => session.id === rememberedSessionId) ||
          workspaceSessionIds.includes(rememberedSessionId)
        ? rememberedSessionId
        : undefined
  if (remembered !== undefined) return remembered

  const rootSessions = sessions
    .filter((session) => session.origin !== 'subagent' && !archived.has(session.id))
    .sort((left, right) => sessionRecency(right) - sessionRecency(left))
  const nonBlankRootSessions = rootSessions.filter((session) => !session.blank)
  const selected =
    nonBlankRootSessions.find(
      (session) => session.status === 'running' || session.status === 'awaiting-input',
    ) ??
    nonBlankRootSessions[0] ??
    rootSessions[0]
  if (selected !== undefined) return selected.id

  // sessionIds is the only durable membership evidence available when the
  // summary projection is temporarily empty. Do not synthesize a SessionSummary;
  // session.open will fetch the authoritative detail from DSH.
  return workspaceSessionIds[0]
}

function findReusableBlankSession(
  sessions: readonly SessionSummary[],
  archivedSessionIds: readonly string[],
  workspace: WorkspaceSummary,
): SessionSummary | undefined {
  const archived = new Set(archivedSessionIds)
  return sessions.find(
    (session) =>
      session.origin !== 'subagent' &&
      session.blank &&
      !archived.has(session.id) &&
      (workspace.sessionIds?.includes(session.id) === true || session.workspaceId === workspace.id),
  )
}

function sessionRecency(session: SessionSummary): number {
  const timestamp = Date.parse(session.updatedAt)
  return Number.isFinite(timestamp) ? timestamp : 0
}

async function safeList<T>(
  client: ProtocolClient,
  request: WebviewRequest,
  guard: (value: unknown) => value is T,
): Promise<readonly T[] | undefined> {
  try {
    const result = await client.request<unknown>(request)
    return strictListValues(result, guard)
  } catch {
    return undefined
  }
}

interface FeedbackListResult {
  readonly items: readonly MessageFeedbackItem[] | undefined
  readonly unavailable: boolean | undefined
}

async function safeFeedbackList(client: ProtocolClient, sessionId: string): Promise<FeedbackListResult> {
  try {
    const result = await client.request<unknown>({
      type: 'feedback.list',
      requestId: requestId(),
      payload: { sessionId },
    })
    const items = strictListValues(result, isMessageFeedbackItem)
    return items === undefined ? { items: undefined, unavailable: undefined } : { items, unavailable: false }
  } catch (error) {
    return {
      items: undefined,
      unavailable: isFeedbackCapabilityUnavailable(error) ? true : undefined,
    }
  }
}

function isFeedbackCapabilityUnavailable(error: unknown): boolean {
  return object(error)?.code === 'CAPABILITY_UNAVAILABLE'
}

function parseSubagentCatalog(value: unknown): SubagentCatalog {
  const catalog = object(value)
  if (
    catalog === undefined ||
    !Array.isArray(catalog.entries) ||
    !catalog.entries.every(isSubagentCatalogEntry) ||
    typeof catalog.parentAvailable !== 'boolean'
  )
    throw new Error(translate('app.error.malformedCatalog'))
  return {
    entries: catalog.entries,
    parentAvailable: catalog.parentAvailable,
  }
}

function parseSubagentHistory(value: unknown): SubagentHistoryPage {
  const page = object(value)
  if (
    page === undefined ||
    !Array.isArray(page.events) ||
    !page.events.every(isSubagentHistoryEvent) ||
    typeof page.hasMore !== 'boolean'
  )
    throw new Error(translate('app.error.malformedHistory'))
  const projection = object(page.projection)
  if (
    page.projection !== undefined &&
    (projection === undefined ||
      !Number.isSafeInteger(projection.asOfSequence) ||
      (projection.asOfSequence as number) < -1 ||
      object(projection.values) === undefined)
  )
    throw new Error(translate('app.error.malformedProjection'))
  const hasBeforeSequence = Object.hasOwn(page, 'beforeSeq')
  const parsedBeforeSequence = optionalSequence(page.beforeSeq)
  if (hasBeforeSequence && parsedBeforeSequence === undefined)
    throw new Error(translate('app.error.malformedHistory'))
  return {
    events: page.events,
    hasMore: page.hasMore,
    ...(parsedBeforeSequence === undefined ? {} : { beforeSequence: parsedBeforeSequence }),
    ...(projection === undefined
      ? {}
      : {
          projection: {
            asOfSequence: projection.asOfSequence as number,
            values: projection.values as Readonly<Record<string, unknown>>,
          },
        }),
  }
}

function isSubagentHistoryEvent(value: unknown): value is SubagentHistoryPage['events'][number] {
  const entry = object(value)
  const event = object(entry?.event)
  return (
    entry !== undefined &&
    Number.isSafeInteger(entry.sequence) &&
    typeof entry.time === 'string' &&
    event !== undefined &&
    typeof event.type === 'string'
  )
}

async function readCommandList(
  client: ProtocolClient,
  sessionId: string,
): Promise<readonly DynamicCommand[] | undefined> {
  const [commandsResult, skillsResult] = await Promise.allSettled([
    client.request<unknown>({
      type: 'command.list',
      requestId: requestId(),
      payload: { sessionId },
    }),
    client.request<unknown>({
      type: 'skill.list',
      requestId: requestId(),
      payload: { sessionId },
    }),
  ])
  if (commandsResult.status === 'rejected' && skillsResult.status === 'rejected') {
    // A registry refresh is advisory. Keep the last known directory when a
    // transient connection failure occurs during commands/change handling.
    return undefined
  }
  const commands =
    commandsResult.status === 'fulfilled'
      ? strictListValues(commandsResult.value, isDynamicCommand)
      : ([] as readonly DynamicCommand[])
  const skills =
    skillsResult.status === 'fulfilled'
      ? strictListValues(skillsResult.value, isSkillDescriptor)
      : ([] as readonly SkillDescriptor[])
  // Each fulfilled endpoint returned a complete directory fragment. A
  // malformed fragment must not be reduced to an empty/partial fragment and
  // merged into the other one; preserve the last complete directory instead.
  if (
    (commandsResult.status === 'fulfilled' && commands === undefined) ||
    (skillsResult.status === 'fulfilled' && skills === undefined)
  )
    return undefined
  if (commands === undefined || skills === undefined) return undefined
  return withClientCommandContributions(mergeSkillCommands(commands, skills))
}

function mergeSkillCommands(
  commands: readonly DynamicCommand[],
  skills: readonly SkillDescriptor[],
): readonly DynamicCommand[] {
  const names = new Set(commands.map((command) => command.name.toLocaleLowerCase()))
  const skillCommands = skills.flatMap((skill) => {
    const name = skill.name.trim()
    const key = name.toLocaleLowerCase()
    if (name === '' || names.has(key)) return []
    names.add(key)
    return [
      {
        name,
        description: skill.enabled
          ? skill.description
          : `${translate('commands.skillUserOnly')} · ${skill.description}`,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        source: 'skill' as const,
        ...(skill.hasDocument === true ? { hasDocument: true } : {}),
      },
    ]
  })
  return [...commands, ...skillCommands]
}

interface SessionModelDirectory {
  readonly models: readonly ModelDescriptor[]
  readonly failures: readonly ModelCatalogFailure[]
  /** The route the session's next request will take, as the host states it. */
  readonly current: ModelSelection
  readonly routable: boolean
}

/**
 * One session-directory read. A read that could not answer carries the reason
 * the seat states: the host's own message for a refused request, or the shape
 * violation when the response cannot be read at all. Swallowing either leaves
 * the composer showing the global catalog as if it were the session's own
 * directory, with no way to ask again.
 */
type SessionModelDirectoryRead =
  | { readonly ok: true; readonly directory: SessionModelDirectory }
  | { readonly ok: false; readonly message: string }

async function loadSessionModelDirectory(
  client: ProtocolClient,
  sessionId: string,
): Promise<SessionModelDirectoryRead> {
  const malformed = translate('app.error.malformedModelDirectory')
  try {
    const result = object(
      await client.request<unknown>({
        type: 'models.session.list',
        requestId: requestId(),
        payload: { sessionId },
      }),
    )
    if (result === undefined || !Array.isArray(result.models) || !result.models.every(isModelDescriptor))
      return { ok: false, message: malformed }
    // The failures are half the directory: they are the only statement about
    // the providers that could not enumerate, so a row this side cannot read
    // invalidates the fragment rather than being dropped from it.
    if (!Array.isArray(result.failures) || !result.failures.every(isModelCatalogFailure))
      return { ok: false, message: malformed }
    // The route the next request will take is the directory's own statement
    // about this session; the configuration only names what someone chose. A
    // fragment without it cannot say what the seat should state, so it is
    // refused rather than left to look like an unstated selection.
    if (!isModelSelection(result.current)) return { ok: false, message: malformed }
    // `routable` is the whole-fragment verdict and the host types it as
    // required; a fragment without it cannot say whether input is legal, so it
    // is refused rather than guessed (a guess would either lock a usable
    // composer or unlock one the host will refuse).
    if (typeof result.routable !== 'boolean') return { ok: false, message: malformed }
    return {
      ok: true,
      directory: {
        models: result.models,
        failures: result.failures,
        current: result.current,
        routable: result.routable,
      },
    }
  } catch (error) {
    return { ok: false, message: errorText(error) }
  }
}

function errorText(error: unknown): string {
  const message = object(error)?.message
  return typeof message === 'string' && message.trim() !== ''
    ? message
    : translate('app.error.hostUnspecified')
}

/**
 * Fold one read into the state. A failed read keeps the last good directory —
 * the open flow has the same contract, and the picker's warning and model rows
 * must not be replaced by an empty directory the host never stated — but the
 * failure itself is published so the seat can explain the missing rows.
 */
function mergeSessionModelDirectory(
  current: AppState,
  sessionId: string,
  read: SessionModelDirectoryRead,
): AppState {
  if (current.activeSessionId !== sessionId) return current
  if (!read.ok) {
    if (!current.sessionModelDirectoryLoading && current.sessionModelDirectoryError === read.message)
      return current
    return { ...current, sessionModelDirectoryLoading: false, sessionModelDirectoryError: read.message }
  }
  const { models, failures, routable, current: selection } = read.directory
  if (
    !current.sessionModelDirectoryLoading &&
    current.sessionModelDirectoryError === undefined &&
    sameModelDescriptorList(current.sessionModels, models) &&
    sameModelCatalogFailureList(current.sessionModelFailures, failures) &&
    sameModelSelection(current.sessionModelCurrent, selection) &&
    current.sessionModelRoutable === routable
  )
    return current
  return {
    ...current,
    sessionModels: models,
    sessionModelFailures: failures,
    sessionModelCurrent: selection,
    sessionModelRoutable: routable,
    sessionModelDirectoryLoading: false,
    sessionModelDirectoryError: undefined,
  }
}

/**
 * Re-read one session's model directory. This is also the seat's retry after a
 * refused read, so it has to be callable on demand and stateful while it runs.
 */
async function refreshSessionModelDirectory(
  client: ProtocolClient,
  setState: StateSetter,
  sessionId: string,
): Promise<void> {
  setState((current) =>
    current.activeSessionId === sessionId && !current.sessionModelDirectoryLoading
      ? { ...current, sessionModelDirectoryLoading: true }
      : current,
  )
  const read = await loadSessionModelDirectory(client, sessionId)
  setState((current) => mergeSessionModelDirectory(current, sessionId, read))
}

function withClientCommandContributions(commands: readonly DynamicCommand[]): readonly DynamicCommand[] {
  if (commands.some((command) => command.name === 'model')) return commands
  return [
    ...commands,
    {
      name: 'model',
      description: translate('commands.modelDescription'),
      source: 'plugin',
    },
  ]
}

function isCommandDirectoryRefresh(value: unknown): boolean {
  const name = object(value)?.name
  return name === 'commands/change' || name === 'agent-preset/selected'
}

/**
 * DSH rc.1 renamed credential invalidation to a reference-scoped event and
 * also publishes owner events when adapter topology or settings documents
 * change. The official model/settings surfaces refresh their catalog in all
 * three cases; keep the Webview's cached provider/model directory coherent
 * without exposing credentials or making the Webview call DSH directly.
 */
function isModelCatalogRefresh(value: unknown): boolean {
  const name = object(value)?.name
  return (
    // rc.6–rc.8 used the broader invalidation name; rc.1 narrowed it to a
    // reference-scoped event. Accept both so an older connected DSH keeps the
    // settings/model cache live after a credential change.
    name === 'credentials/updated' ||
    name === 'credentials/reference-updated' ||
    name === 'llm/adapters-updated' ||
    name === 'settings/document-updated'
  )
}

function strictListValues<T>(
  value: unknown,
  guard: (value: unknown) => value is T,
): readonly T[] | undefined {
  const values = Array.isArray(value) ? value : object(value)?.items
  if (!Array.isArray(values) || !values.every(guard)) return undefined
  return values
}

/**
 * Provider discovery is a mixed live/configurable directory. Keep valid rows
 * when an optional catalog row is malformed so one bad upstream entry cannot
 * hide the live providers that the user can actually use.
 */
function listValues(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value
  const record = object(value)
  return Array.isArray(record?.items) ? record.items : []
}

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every((entry): entry is string => typeof entry === 'string') ? value : undefined
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)]
}

function mergeUniqueStrings(current: readonly string[], additions: readonly string[]): readonly string[] {
  const seen = new Set(current)
  let next: string[] | undefined
  for (const value of additions) {
    if (seen.has(value)) continue
    seen.add(value)
    if (next === undefined) next = [...current]
    next.push(value)
  }
  return next ?? current
}

function deduplicateSessionSummaries(sessions: readonly SessionSummary[]): readonly SessionSummary[] {
  const seen = new Set<string>()
  const unique: SessionSummary[] = []
  for (const session of sessions) {
    if (seen.has(session.id)) continue
    seen.add(session.id)
    unique.push(session)
  }
  return unique
}

function sameSessionSummaryList(left: readonly SessionSummary[], right: readonly SessionSummary[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index]
    const next = right[index]
    if (previous === undefined || next === undefined || !sameSessionSummary(previous, next)) return false
  }
  return true
}

function sameSessionSummary(left: SessionSummary, right: SessionSummary): boolean {
  return (
    left.id === right.id &&
    left.workspaceId === right.workspaceId &&
    left.workspaceFolderId === right.workspaceFolderId &&
    left.title === right.title &&
    left.blank === right.blank &&
    left.parentSessionId === right.parentSessionId &&
    left.origin === right.origin &&
    left.agentAvailable === right.agentAvailable &&
    left.status === right.status &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.modelLabel === right.modelLabel &&
    left.agentPreset === right.agentPreset &&
    sameSessionProjection(left.projection, right.projection)
  )
}

function sameSessionProjection(
  left: SessionSummary['projection'],
  right: SessionSummary['projection'],
): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined || left.asOfSequence !== right.asOfSequence) return false
  const leftKeys = Object.keys(left.values)
  const rightKeys = Object.keys(right.values)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) if (!Object.is(left.values[key], right.values[key])) return false
  return true
}

function sameWorkspaceSummaryList(
  left: readonly WorkspaceSummary[],
  right: readonly WorkspaceSummary[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index]
    const next = right[index]
    if (previous === undefined || next === undefined || !sameWorkspaceSummary(previous, next)) return false
  }
  return true
}

function sameWorkspaceSummary(left: WorkspaceSummary, right: WorkspaceSummary): boolean {
  if (
    left.id !== right.id ||
    left.name !== right.name ||
    left.createdAt !== right.createdAt ||
    left.updatedAt !== right.updatedAt ||
    left.sessionCount !== right.sessionCount
  )
    return false
  const leftSessionIds = left.sessionIds
  const rightSessionIds = right.sessionIds
  if (leftSessionIds === rightSessionIds) return true
  if (leftSessionIds === undefined || rightSessionIds === undefined) return leftSessionIds === rightSessionIds
  if (leftSessionIds.length !== rightSessionIds.length) return false
  return leftSessionIds.every((sessionId, index) => sessionId === rightSessionIds[index])
}

function sameModelProviderList(left: readonly ModelProvider[], right: readonly ModelProvider[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index]
    const next = right[index]
    if (previous === undefined || next === undefined || !sameModelProvider(previous, next)) return false
  }
  return true
}

function sameModelProvider(left: ModelProvider, right: ModelProvider): boolean {
  if (
    left.id !== right.id ||
    left.name !== right.name ||
    left.kind !== right.kind ||
    left.configurable !== right.configurable ||
    left.active !== right.active ||
    left.declared !== right.declared ||
    left.settingsNs !== right.settingsNs ||
    !sameStringList(left.settingsPath, right.settingsPath) ||
    left.fields.length !== right.fields.length
  )
    return false
  for (let index = 0; index < left.fields.length; index += 1) {
    const previous = left.fields[index]
    const next = right.fields[index]
    if (
      previous === undefined ||
      next === undefined ||
      previous.key !== next.key ||
      previous.label !== next.label ||
      previous.secret !== next.secret ||
      previous.required !== next.required ||
      !sameStringList(previous.enumValues, next.enumValues) ||
      previous.writable !== next.writable ||
      previous.value !== next.value
    )
      return false
  }
  return true
}

function sameModelDescriptorList(
  left: readonly ModelDescriptor[],
  right: readonly ModelDescriptor[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index]
    const next = right[index]
    if (
      previous === undefined ||
      next === undefined ||
      previous.id !== next.id ||
      previous.providerId !== next.providerId ||
      previous.label !== next.label ||
      previous.contextWindow !== next.contextWindow ||
      previous.supportsReasoning !== next.supportsReasoning ||
      previous.defaultReasoningLevel !== next.defaultReasoningLevel ||
      !sameReasoningLevelList(previous.reasoningLevels, next.reasoningLevels)
    )
      return false
  }
  return true
}

function sameModelCatalogFailureList(
  left: readonly ModelCatalogFailure[],
  right: readonly ModelCatalogFailure[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index]
    const next = right[index]
    if (
      previous === undefined ||
      next === undefined ||
      previous.providerId !== next.providerId ||
      previous.providerName !== next.providerName ||
      previous.message !== next.message
    )
      return false
  }
  return true
}

function samePresetDescriptorList(
  left: readonly AgentPresetDescriptor[],
  right: readonly AgentPresetDescriptor[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index]
    const next = right[index]
    if (
      previous === undefined ||
      next === undefined ||
      previous.id !== next.id ||
      previous.trust !== next.trust ||
      previous.isDefault !== next.isDefault ||
      previous.name !== next.name ||
      previous.description !== next.description ||
      previous.broken !== next.broken
    )
      return false
  }
  return true
}

function sameStringList(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined || left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

/**
 * The seat names an effort with the adapter's label and sends its id back, so
 * both halves belong to the identity of an advertised level.
 */
function sameReasoningLevelList(
  left: readonly ModelReasoningLevel[] | undefined,
  right: readonly ModelReasoningLevel[] | undefined,
): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined || left.length !== right.length) return false
  return left.every((level, index) => level.id === right[index]?.id && level.label === right[index]?.label)
}

function upsertOpenedSession(
  sessions: readonly SessionSummary[],
  detail: Record<string, unknown> | undefined,
  sessionId: string,
): readonly SessionSummary[] {
  const opened = isSessionSummary(detail) ? detail : undefined
  if (opened === undefined) return sessions
  const withoutOpened = sessions.filter((session) => session.id !== sessionId)
  return [...withoutOpened, opened]
}

function updateSessionById(
  sessions: readonly SessionSummary[],
  sessionId: string,
  update: (session: SessionSummary) => SessionSummary,
): readonly SessionSummary[] {
  let changed = false
  const next = sessions.map((session) => {
    if (session.id !== sessionId) return session
    const updated = update(session)
    if (updated !== session) changed = true
    return updated
  })
  return changed ? next : sessions
}

function applyHostMessage(
  message: HostMessage,
  state: AppState,
  setState: StateSetter,
  appendLiveHistory?: LiveHistoryAppender,
  parsedEvent?: BackendEvent | null,
  onSessionGap?: (event: Extract<BackendEvent, { type: 'session.gap' }>) => void,
  projectionSequences?: ProjectionSequenceIndex,
  onHostOnlyNodes?: (sessionId: string, nodes: readonly TimelineNode[], anchors: readonly string[]) => void,
  onConnectionEpoch?: () => void,
): void {
  if (message.type !== 'event') return
  if (message.name === 'runtime.update.progress') {
    const progress = parseDshUpdateProgress(message.payload)
    if (progress !== undefined) setState({ ...state, dshUpdateProgress: progress })
    return
  }
  if (message.name === 'ui.sessions.toggle') {
    setState({ ...state, drawer: state.drawer === 'sessions' ? undefined : 'sessions' })
    return
  }
  if (message.name === 'ui.settings.toggle') {
    setState({ ...state, drawer: state.drawer === 'settings' ? undefined : 'settings' })
    return
  }
  if (message.name === 'connection.snapshot') {
    const snapshot = object(message.payload)
    const kind = snapshot?.kind
    // A manual reconnect publishes stopping/idle before the new connected
    // epoch and may not emit connection.lost. Projection cuts belong to one
    // DSH process epoch, so never let the previous process watermark reject
    // the replacement's lower sequence baseline.
    if (kind !== 'connected') {
      projectionSequences?.perKey.clear()
      projectionSequences?.baselines.clear()
    }
    // Leaving `connected` means the process that owned the live queue,
    // approvals and catalogs is gone. `connected` -> `connected` is the
    // coordinator's cached-backend fast path, where every surface stays valid.
    const base =
      state.backend.kind === 'connected' && kind !== 'connected'
        ? withoutConnectionScopedSurfaces(state)
        : state
    if (kind === 'runtime-missing') {
      const searchedLocations = Array.isArray(snapshot?.searchedLocations)
        ? snapshot.searchedLocations.filter((entry): entry is string => typeof entry === 'string')
        : []
      setState({
        ...base,
        backend: { kind, searchedLocations },
        connectedDshVersion: undefined,
        subagentImagePrompts: false,
        sessionRestore: false,
        jobControllerAvailable: false,
        dshCompatibilityWarning: undefined,
        featureProfile: undefined,
      })
    } else if (
      kind === 'idle' ||
      kind === 'locating-runtime' ||
      kind === 'discovering' ||
      kind === 'connecting' ||
      kind === 'starting' ||
      kind === 'connected' ||
      kind === 'failed' ||
      kind === 'port-conflict' ||
      kind === 'stopping'
    ) {
      if (kind === 'failed')
        setState({
          ...base,
          connectedDshVersion: undefined,
          subagentImagePrompts: false,
          sessionRestore: false,
          jobControllerAvailable: false,
          dshCompatibilityWarning: undefined,
          featureProfile: undefined,
          backend: {
            kind,
            message:
              typeof snapshot?.message === 'string'
                ? snapshot.message
                : translate('app.error.connectionFailed'),
            retryable: snapshot?.retryable === true,
          },
        })
      else if (kind === 'port-conflict')
        setState({
          ...base,
          connectedDshVersion: undefined,
          subagentImagePrompts: false,
          sessionRestore: false,
          jobControllerAvailable: false,
          dshCompatibilityWarning: undefined,
          featureProfile: undefined,
          backend: {
            kind,
            port: typeof snapshot?.port === 'number' ? snapshot.port : 0,
            message:
              typeof snapshot?.message === 'string' ? snapshot.message : translate('app.error.portConflict'),
            retryable: snapshot?.retryable === true,
          },
        })
      else
        setState({
          ...base,
          backend: { kind },
          connectedDshVersion:
            kind === 'connected' && typeof snapshot?.dshVersion === 'string'
              ? snapshot.dshVersion
              : undefined,
          sessionRestore: kind === 'connected' && snapshot?.sessionRestore === true,
          jobControllerAvailable: kind === 'connected' && snapshot?.jobController === true,
          subagentImagePrompts: kind === 'connected' && snapshot?.subagentImagePrompts === true,
          dshCompatibilityWarning:
            kind === 'connected' && typeof snapshot?.compatibilityWarning === 'string'
              ? snapshot.compatibilityWarning
              : undefined,
          featureProfile:
            kind === 'connected' ? parseFeatureCapabilityProfile(snapshot?.featureProfile) : undefined,
        })
      // Every DSH process owns its own follow subscriptions. The replacement
      // process never inherits the previous one's, so the conversation on
      // screen would silently stop receiving model and tool events even
      // though the shell reports a healthy connection.
      if (kind === 'connected' && state.backend.kind !== 'connected') onConnectionEpoch?.()
    }
    return
  }
  const event = parsedEvent === undefined ? domainEvent(message.name, message.payload) : parsedEvent
  if (event === undefined || event === null) return
  const eventSessionId = backendEventSessionId(event)
  const transientSequence =
    event.type === 'message.delta' || event.type === 'reasoning.delta' ? event.transientSequence : undefined
  const belongsToActiveSession = eventSessionId === undefined || eventSessionId === state.activeSessionId
  const controlPlaneMessage = event.type === 'message.user' && isCommandMessageSource(event.source)
  let history = state.history
  if (
    state.activeSessionId !== undefined &&
    eventSessionId === state.activeSessionId &&
    event.sequence !== undefined
  ) {
    const entry = {
      sequence: event.sequence,
      time: historyTime(event),
      event,
    }
    if (appendLiveHistory === undefined) history = mergeHistory(state.history, [entry])
    else appendLiveHistory(state.activeSessionId, entry)
  }
  if (event.type === 'session.gap') {
    if (belongsToActiveSession && onSessionGap !== undefined) onSessionGap(event)
    // Recovery backfills the hole from history and rebuilds the timeline, so
    // repeated announcements of the same range must not stack notice nodes.
    // The active-session path defers the notice until recovery confirms that
    // history still cannot cover the announced range.
  }
  // Command records are control-plane history and stay out of the rendered
  // Chat surface. Other producer-owned user/message records remain available
  // as context nodes without being rendered as ordinary chat bubbles.
  const gapNodeId =
    event.type === 'session.gap'
      ? `gap:${event.sessionId}:${event.fromSequence}:${event.toSequence}`
      : undefined
  const duplicateGapNotice =
    gapNodeId !== undefined && state.timeline.nodes.some((node) => node.id === gapNodeId)
  const deferGapNotice = event.type === 'session.gap' && onSessionGap !== undefined && belongsToActiveSession
  // Host-only rows (command notices, agent errors, raw frames the Host could
  // not map to a durable DSH record) carry no durable cursor. Falling back to
  // the Host publication counter for the reduce input would let that counter
  // spend a durable slot: a durable row below it then looks stale and
  // disappears until a rebuild, and the host-only row itself is dropped
  // whenever the counter happens to sit behind the DSH sequence (a reloaded
  // Webview, a session resumed from history). Order them by arrival instead.
  // Cursorless assistant deltas keep the sequence comparison: without transient
  // attempt metadata that comparison is the only thing that keeps a live delta
  // already covered by the hydrated history from being appended twice.
  const sequenceOptions =
    event.sequence === undefined && transientSequence === undefined && !isAssistantDelta(event)
      ? { advanceSequence: false as const }
      : timelineSequenceOptions(event)
  const timeline =
    !belongsToActiveSession ||
    controlPlaneMessage ||
    !eventMayChangeTimelineState(event) ||
    duplicateGapNotice ||
    deferGapNotice
      ? state.timeline
      : reduceTimeline(state.timeline, {
          sequence: event.sequence ?? transientSequence ?? message.sequence,
          event,
          // Some DSH lifecycle/projection events carry the durable DSH
          // sequence even though they are not timeline records. They must
          // never move the conversation cursor: doing so can make the next
          // live delta look stale until history is replayed after switching
          // sessions.
          ...sequenceOptions,
        })
  if (timeline !== state.timeline && belongsToActiveSession && onHostOnlyNodes !== undefined) {
    const sessionId = timeline.sessionId
    const hostOnly = timeline.nodes.slice(state.timeline.nodes.length).filter(isHostOnlyTimelineNode)
    if (sessionId !== undefined && hostOnly.length > 0)
      onHostOnlyNodes(
        sessionId,
        hostOnly,
        state.timeline.nodes
          .slice(-4)
          .map((node) => node.id)
          .reverse(),
      )
  } else if (
    !belongsToActiveSession &&
    onHostOnlyNodes !== undefined &&
    eventSessionId !== undefined &&
    !controlPlaneMessage &&
    eventMayChangeTimelineState(event)
  ) {
    // DSH publishes notices for every watched session, so a host-only row can
    // arrive while another session is open. It is dropped from the active
    // transcript by design, but DSH history never carries it either: remember
    // it for its own session or opening that session loses it silently.
    const scratch = reduceTimeline(hydrateTimelineFromEntries(eventSessionId, []), {
      sequence: event.sequence ?? transientSequence ?? message.sequence,
      event,
      advanceSequence: false,
    })
    const hostOnly = scratch.nodes.filter(isHostOnlyTimelineNode)
    // No anchor rows are known for a session that is not open; the restored
    // row lands at the end of its transcript.
    if (hostOnly.length > 0) onHostOnlyNodes(eventSessionId, hostOnly, [])
  }
  let next: AppState =
    timeline === state.timeline && history === state.history ? state : { ...state, timeline, history }
  if (event.type === 'session.status') {
    const activity: 'running' | 'inactive' = event.status === 'running' ? 'running' : 'inactive'
    const status = sessionStatus(event.status)
    const sessions = updateSessionById(next.sessions, event.sessionId, (session) => {
      if (session.status === status && (event.status !== 'running' || session.blank === false)) return session
      return {
        ...session,
        status,
        ...(event.status === 'running' ? { blank: false } : {}),
      }
    })
    let subagents = next.subagents
    const childIndex = subagents.entries.findIndex(
      (entry) => entry.kind === 'child' && entry.id === event.sessionId && entry.activity !== activity,
    )
    if (childIndex >= 0) {
      const entries = [...subagents.entries]
      const child = entries[childIndex]
      if (child?.kind === 'child') entries[childIndex] = { ...child, activity }
      subagents = { ...subagents, entries }
    }
    const activeSubagent =
      next.activeSubagent?.entry.id === event.sessionId && next.activeSubagent.entry.activity !== activity
        ? {
            ...next.activeSubagent,
            entry: { ...next.activeSubagent.entry, activity },
          }
        : next.activeSubagent
    if (sessions !== next.sessions || subagents !== next.subagents || activeSubagent !== next.activeSubagent)
      next = { ...next, sessions, subagents, activeSubagent }
  } else if (event.type === 'session.activity') {
    const updatedAt = new Date(event.updatedAt).toISOString()
    const sessions = updateSessionById(next.sessions, event.sessionId, (session) => {
      const nextUpdatedAt = laterSessionTimestamp(session.updatedAt, event.updatedAt, updatedAt)
      return nextUpdatedAt === session.updatedAt ? session : { ...session, updatedAt: nextUpdatedAt }
    })
    if (sessions !== next.sessions) next = { ...next, sessions }
  } else if (event.type === 'session.title' && event.title.trim() !== '') {
    const sessions = updateSessionById(next.sessions, event.sessionId, (session) =>
      session.blank || session.title === event.title ? session : { ...session, title: event.title },
    )
    if (sessions !== next.sessions) next = { ...next, sessions }
  } else if (event.type === 'session.projection.baseline') {
    const projections = setSessionProjectionBaseline(event.projections, projectionSequences)
    if (projections !== next.projections) next = { ...next, projections }
    for (const [sessionId, projection] of Object.entries(event.projections))
      for (const [key, value] of Object.entries(projection.values))
        next = applySessionProjectionPresentation(next, sessionId, key, value)

    if (next.activeSessionId !== undefined && next.configuration !== undefined) {
      const values = event.projections[next.activeSessionId]?.values
      const plan = object(values?.plan)
      const permissions = object(values?.permissions)
      const planModeKnown = typeof plan?.active === 'boolean'
      const permissionPresetKnown =
        typeof permissions?.currentValue === 'string' && permissions.currentValue.trim() !== ''
      next = {
        ...next,
        configuration: {
          ...next.configuration,
          ...(planModeKnown ? { planMode: plan.active as boolean } : {}),
          planModeKnown,
          ...(permissionPresetKnown ? { permissionPreset: permissions.currentValue as string } : {}),
          permissionPresetKnown,
        },
      }
    }
  } else if (event.type === 'session.projection') {
    const projectionAccepted = currentProjectionSequence(
      projectionSequences,
      event.sessionId,
      event.key,
      event.sequence,
    )
    const projections = updateSessionProjection(
      next.projections,
      event.sessionId,
      event.key,
      event.value,
      event.sequence,
      projectionSequences,
    )
    if (projections !== next.projections) next = { ...next, projections }
    if (projectionAccepted)
      next = applySessionProjectionPresentation(next, event.sessionId, event.key, event.value)
  } else if (event.type === 'session.subscribed') {
    // queue/jobs and pending interactions are process-local snapshots. The
    // pinned mux starts every subscription with `session/subscribed` and only
    // follows it with a queue/jobs frame when that snapshot is non-empty.
    const queue = event.sessionId !== next.activeSessionId || next.queue.length === 0 ? next.queue : []
    const jobs = event.sessionId !== next.activeSessionId || next.jobs.length === 0 ? next.jobs : []
    const permissions =
      event.controlBaseline === false
        ? next.permissions
        : removeMatching(next.permissions, (request) => request.sessionId === event.sessionId)
    const questions =
      event.controlBaseline === false
        ? next.questions
        : removeMatching(next.questions, (question) => question.sessionId === event.sessionId)
    if (
      (event.controlBaseline !== false && (queue !== next.queue || jobs !== next.jobs)) ||
      permissions !== next.permissions ||
      questions !== next.questions ||
      event.projection !== undefined
    )
      next = {
        ...next,
        ...(event.controlBaseline === false ? {} : { queue, jobs }),
        permissions,
        questions,
        ...(event.projection === undefined
          ? {}
          : {
              projections: setSessionProjection(
                next.projections,
                event.sessionId,
                event.projection,
                projectionSequences,
              ),
            }),
      }
  } else if (event.type === 'session.configuration' && event.sessionId === next.activeSessionId) {
    next = {
      ...next,
      configuration:
        next.configuration === undefined
          ? next.configuration
          : mergeConfigurationPatch(next.configuration, event.patch),
    }
  } else if (event.type === 'session.removed') {
    projectionSequences?.perKey.delete(event.sessionId)
    projectionSequences?.baselines.delete(event.sessionId)
    const wasActive = next.activeSessionId === event.sessionId
    next = {
      ...next,
      permissions: next.permissions.filter((request) => request.sessionId !== event.sessionId),
      questions: next.questions.filter((question) => question.sessionId !== event.sessionId),
      sessions: next.sessions.filter((session) => session.id !== event.sessionId),
      subagents: {
        ...next.subagents,
        entries: next.subagents.entries.filter((entry) => entry.id !== event.sessionId),
      },
      ...(wasActive
        ? {
            activeSessionId: undefined,
            timeline: {
              sessionId: undefined,
              nodes: [],
              lastSequence: -1,
              nodeChangeStart: 0,
              eventCount: 0,
            },
            history: [],
            historyHasMore: false,
            historyBeforeSequence: undefined,
            historyLoading: false,
            projections: removeSessionProjection(next.projections, event.sessionId),
            configuration: undefined,
            sessionModels: [],
            sessionModelFailures: [],
            sessionModelCurrent: undefined,
            sessionModelRoutable: undefined,
            sessionModelDirectoryLoading: false,
            sessionModelDirectoryError: undefined,
            permissionPresets: [],
            queue: [],
            goals: [],
            todos: [],
            jobs: [],
            jobFollow: undefined,
            feedback: {},
            feedbackUnavailable: false,
            subagents: EMPTY_SUBAGENT_CATALOG,
            activeSubagent: undefined,
            commands: [],
          }
        : {}),
    }
  } else if (event.type === 'session.added' && event.origin === 'subagent') {
    let changed = false
    const entries = next.subagents.entries.map((entry) => {
      if (entry.kind !== 'child' || entry.id !== event.parentSessionId || entry.hasChildren) return entry
      changed = true
      return { ...entry, hasChildren: true }
    })
    if (changed) next = { ...next, subagents: { ...next.subagents, entries } }
  } else if (event.type === 'message.user') {
    // A command-only session remains blank. The first real user message is
    // the rc.6 boundary that turns the reusable placeholder into history.
    const sessions = updateSessionById(next.sessions, event.sessionId, (session) =>
      session.id === event.sessionId && !isCommandMessageSource(event.source) && !isInjectedUserMessage(event)
        ? { ...session, blank: false }
        : session,
    )
    if (sessions !== next.sessions) next = { ...next, sessions }
    if (
      event.sessionId === next.activeSessionId &&
      !isCommandMessageSource(event.source) &&
      !isInjectedUserMessage(event)
    ) {
      const queue = removeAdmittedQueueInput(next.queue, event)
      if (queue !== next.queue) next = { ...next, queue }
    }
  } else if (event.type === 'queue.updated' && event.sessionId === next.activeSessionId) {
    if (!sameQueuedInputList(next.queue, event.items)) next = { ...next, queue: event.items }
  } else if (event.type === 'goal.updated' && event.sessionId === next.activeSessionId) {
    if (!sameGoalList(next.goals, event.goals)) next = { ...next, goals: event.goals }
  } else if (event.type === 'todo.updated' && event.sessionId === next.activeSessionId) {
    if (!sameTodoList(next.todos, event.todos)) next = { ...next, todos: event.todos }
  } else if (event.type === 'jobs.updated' && event.sessionId === next.activeSessionId) {
    if (!sameJobList(next.jobs, event.jobs)) next = { ...next, jobs: event.jobs }
  } else if (event.type === 'job.follow.updated' && event.sessionId === next.activeSessionId) {
    if (next.jobFollow?.jobId === event.jobId) {
      const jobFollow = reduceJobFollow(next.jobFollow, event.jobId, event.frame)
      if (jobFollow !== next.jobFollow) next = { ...next, jobFollow }
    }
  } else if (event.type === 'permission.resolved') {
    const permissions = removeMatching(
      next.permissions,
      (request) => request.sessionId === event.sessionId && request.id === event.requestId,
    )
    if (permissions !== next.permissions) next = { ...next, permissions }
  } else if (event.type === 'question.resolved') {
    const questions = removeMatching(
      next.questions,
      (question) =>
        question.sessionId === event.sessionId &&
        (question.id === event.questionId ||
          (event.questionRpcId !== undefined && question.rpcId === event.questionRpcId)),
    )
    if (questions !== next.questions) next = { ...next, questions }
  } else if (event.type === 'permission.requested') {
    next = {
      ...next,
      permissions: [...next.permissions.filter((request) => request.id !== event.request.id), event.request],
    }
  } else if (event.type === 'question.requested') {
    next = {
      ...next,
      questions: [...next.questions.filter((question) => question.id !== event.question.id), event.question],
    }
  } else if (event.type === 'connection.lost') {
    projectionSequences?.perKey.clear()
    projectionSequences?.baselines.clear()
    next = {
      ...withoutConnectionScopedSurfaces(next),
      backend: { kind: 'failed', message: event.reason, retryable: true },
      connectedDshVersion: undefined,
      subagentImagePrompts: false,
      sessionRestore: false,
      jobControllerAvailable: false,
      dshCompatibilityWarning: undefined,
      featureProfile: undefined,
    }
  }
  if (next !== state) setState(next)
}

/**
 * Process-local surfaces that only exist inside one DSH process. The pinned
 * mux re-announces them when a session is subscribed again, so a new process
 * fills them in by itself; until then they must not be shown as if they still
 * belonged to the replacement process. Used by connection loss and by every
 * connection restart that never publishes one.
 */
function withoutConnectionScopedSurfaces(state: AppState): AppState {
  const withoutPresetSelection = withPresetSelectionEnabled(state, undefined)
  return {
    ...withoutPresetSelection,
    queue: [],
    jobs: [],
    jobFollow: undefined,
    feedback: {},
    feedbackUnavailable: false,
    editorContext: [],
    editorContextAvailableKinds: [],
    editorContextLoading: false,
    changes: [],
    changesRefreshFailed: false,
    changesLoading: false,
    tasks: [],
    tasksLoading: false,
    taskScope: 'current-session',
    tasksComplete: true,
    tasksOmittedSessions: 0,
    promptTemplates: [],
    promptTemplatesLoading: false,
    promptMode: 'ask',
    permissions: [],
    questions: [],
    subagents: EMPTY_SUBAGENT_CATALOG,
    commands: [],
  }
}

function withPresetSelectionEnabled(state: AppState, enabled: boolean | undefined): AppState {
  if (state.presetSelectionEnabled === enabled) return state
  return { ...state, presetSelectionEnabled: enabled }
}

function replayHostMessages(
  state: AppState,
  messages: readonly HostMessage[],
  onSessionGap?: (event: Extract<BackendEvent, { type: 'session.gap' }>) => void,
  projectionSequences?: ProjectionSequenceIndex,
  onHostOnlyNodes?: (sessionId: string, nodes: readonly TimelineNode[], anchors: readonly string[]) => void,
): AppState {
  let replayed = state
  const pendingHistory = new Map<string, SessionHistoryEvent[]>()
  const appendReplayHistory: LiveHistoryAppender = (sessionId, entry): void => {
    const entries = pendingHistory.get(sessionId)
    if (entries === undefined) pendingHistory.set(sessionId, [entry])
    else entries.push(entry)
  }
  const setReplayed: StateSetter = (next) => {
    replayed = typeof next === 'function' ? next(replayed) : next
  }
  for (const message of messages)
    applyHostMessage(
      message,
      replayed,
      setReplayed,
      appendReplayHistory,
      undefined,
      onSessionGap,
      projectionSequences,
      onHostOnlyNodes,
    )
  const additions = pendingHistory.get(replayed.activeSessionId ?? '')
  if (additions !== undefined) {
    const history = mergeHistory(replayed.history, additions)
    if (history !== replayed.history) replayed = { ...replayed, history }
  }
  return replayed
}

function parseHostDomainEvent(message: HostMessage): BackendEvent | null | undefined {
  if (message.type !== 'event') return undefined
  if (
    message.name === 'runtime.update.progress' ||
    message.name === 'ui.sessions.toggle' ||
    message.name === 'ui.settings.toggle' ||
    message.name === 'connection.snapshot'
  )
    return undefined
  return domainEvent(message.name, message.payload) ?? null
}

function backendEventSessionId(event: BackendEvent): string | undefined {
  if ('sessionId' in event && typeof event.sessionId === 'string') return event.sessionId
  if ('request' in event && typeof event.request.sessionId === 'string') return event.request.sessionId
  if ('question' in event && typeof event.question.sessionId === 'string') return event.question.sessionId
  if ('retry' in event && typeof event.retry.sessionId === 'string') return event.retry.sessionId
  return undefined
}

function isHostOnlyInterruptedCompletion(event: BackendEvent): boolean {
  return event.type === 'message.completed' && event.interrupted === true && event.sequence === undefined
}

function isAssistantDelta(event: BackendEvent): boolean {
  return event.type === 'message.delta' || event.type === 'reasoning.delta'
}

/**
 * Rows only the Extension Host publishes: DSH history never replays them, so
 * any path that rebuilds the transcript from history has to put them back
 * explicitly. Gap warnings are excluded; they are restored from
 * `unhealedGapRanges`, which knows whether the hole was healed by a backfill.
 */
function isHostOnlyTimelineNode(node: TimelineNode): boolean {
  return node.kind === 'command-input' || (node.kind === 'notice' && !node.id.startsWith('gap:'))
}

/** Position a remembered row behind the nearest of its recorded neighbour rows. */
function hostOnlyInsertIndex(nodes: readonly TimelineNode[], anchors: readonly string[]): number {
  for (const anchor of anchors) {
    const index = nodes.findIndex((node) => node.id === anchor)
    if (index >= 0) return index + 1
  }
  return nodes.length
}

/** Only durable conversation records advance the DSH timeline cursor. */
function advancesTimelineSequence(event: BackendEvent): boolean {
  switch (event.type) {
    case 'archived.sessions.changed':
    case 'connection.lost':
    case 'jobs.updated':
    case 'job.follow.updated':
    case 'permission.requested':
    case 'permission.resolved':
    case 'question.requested':
    case 'question.resolved':
    case 'queue.updated':
    case 'session.added':
    case 'session.activity':
    case 'session.configuration':
    case 'session.projection.baseline':
    case 'session.projection':
    case 'session.removed':
    case 'session.status':
    case 'session.subscribed':
    case 'session.system':
    case 'session.title':
    case 'workspace.changed':
    case 'workspace.order.changed':
    case 'workspace.removed':
    case 'remote.event':
      return false
    case 'unknown':
      // An uninterpreted frame is preserved as a raw event row, but it must
      // never spend a durable cursor slot. DSH legitimately carries several
      // rows in one sequence (projections, replay races), so a row this build
      // cannot read must not make a renderable neighbour look stale.
      return false
    default:
      return true
  }
}

/**
 * Keep the live and history-replay cursor rules identical.
 *
 * A streamed delta can carry the durable frame sequence as transport
 * metadata, but it is still only a transient projection of the assistant
 * message. If replay lets that delta consume the cursor, the durable
 * `message.completed` frame at the same sequence is rejected as stale and
 * the completed answer disappears after a ledger rebuild.
 */
function timelineSequenceOptions(event: BackendEvent): { readonly advanceSequence?: false } {
  const transientSequence =
    event.type === 'message.delta' || event.type === 'reasoning.delta' ? event.transientSequence : undefined
  return !advancesTimelineSequence(event) ||
    transientSequence !== undefined ||
    isHostOnlyInterruptedCompletion(event)
    ? { advanceSequence: false }
    : {}
}

/** Session/catalog state events do not need a new TimelineState object. */
function eventMayChangeTimelineState(event: BackendEvent): boolean {
  switch (event.type) {
    case 'archived.sessions.changed':
    case 'jobs.updated':
    case 'job.follow.updated':
    case 'permission.resolved':
    case 'permission.requested':
    case 'question.requested':
    case 'question.resolved':
    case 'queue.updated':
    case 'session.activity':
    case 'session.added':
    case 'session.configuration':
    case 'session.projection.baseline':
    case 'session.projection':
    case 'session.removed':
    case 'session.status':
    case 'session.subscribed':
    case 'session.system':
    case 'session.title':
    case 'workspace.changed':
    case 'workspace.order.changed':
    case 'workspace.removed':
    case 'remote.event':
      return false
    default:
      return true
  }
}

function sessionStatus(value: string): SessionSummary['status'] {
  if (value === 'running') return 'running'
  if (value === 'awaiting-input') return 'awaiting-input'
  if (value === 'failed') return 'failed'
  if (value === 'completed') return 'completed'
  return 'idle'
}

function laterSessionTimestamp(current: string, candidateMs: number, candidate: string): string {
  const currentMs = Date.parse(current)
  return Number.isFinite(currentMs) && currentMs > candidateMs ? current : candidate
}

function isCommandMessageSource(source: string | undefined): boolean {
  return source?.toLowerCase().includes('command') === true
}

function mergeConfigurationPatch(
  configuration: AgentConfiguration,
  patch: SessionConfigurationPatch,
): AgentConfiguration {
  return {
    ...configuration,
    ...patch,
    model: patch.model === undefined ? configuration.model : { ...configuration.model, ...patch.model },
  }
}

function configurationPatch(value: Record<string, unknown>): SessionConfigurationPatch | undefined {
  const modelValue = value.model
  if (
    (value.preset !== undefined && typeof value.preset !== 'string') ||
    (value.toolMode !== undefined && !isToolMode(value.toolMode)) ||
    (value.permissionPreset !== undefined && typeof value.permissionPreset !== 'string') ||
    (value.planMode !== undefined && typeof value.planMode !== 'boolean') ||
    (value.sandboxMode !== undefined && typeof value.sandboxMode !== 'string') ||
    (value.approvalPolicy !== undefined && typeof value.approvalPolicy !== 'string') ||
    (modelValue !== undefined && !isRecord(modelValue))
  )
    return undefined
  if (
    isRecord(modelValue) &&
    ((modelValue.providerId !== undefined && typeof modelValue.providerId !== 'string') ||
      (modelValue.modelId !== undefined && typeof modelValue.modelId !== 'string') ||
      (modelValue.reasoningLevel !== undefined && typeof modelValue.reasoningLevel !== 'string'))
  )
    return undefined
  const model = isRecord(modelValue)
    ? {
        ...(typeof modelValue.providerId === 'string' ? { providerId: modelValue.providerId } : {}),
        ...(typeof modelValue.modelId === 'string' ? { modelId: modelValue.modelId } : {}),
        ...(typeof modelValue.reasoningLevel === 'string'
          ? { reasoningLevel: modelValue.reasoningLevel }
          : {}),
      }
    : undefined
  return {
    ...(typeof value.preset === 'string' ? { preset: value.preset } : {}),
    ...(isToolMode(value.toolMode) ? { toolMode: value.toolMode } : {}),
    ...(typeof value.permissionPreset === 'string'
      ? { permissionPreset: value.permissionPreset, permissionPresetKnown: true }
      : {}),
    ...(typeof value.planMode === 'boolean' ? { planMode: value.planMode, planModeKnown: true } : {}),
    ...(typeof value.sandboxMode === 'string' ? { sandboxMode: value.sandboxMode } : {}),
    ...(typeof value.approvalPolicy === 'string' ? { approvalPolicy: value.approvalPolicy } : {}),
    ...(model === undefined ? {} : { model }),
  }
}

function latestTodos(timeline: TimelineState): readonly TodoView[] {
  for (let index = timeline.nodes.length - 1; index >= 0; index -= 1) {
    const node = timeline.nodes[index]
    if (node?.kind === 'todo') return node.todos
  }
  return []
}

function setSessionProjection(
  projections: AppState['projections'],
  sessionId: string,
  projection: unknown,
  projectionSequences?: ProjectionSequenceIndex,
): AppState['projections'] {
  const record = object(projection)
  const values = object(record?.values)
  if (values === undefined) return projections
  const sequence = projectionAsOfSequence(record?.asOfSequence)
  // Older adapters did not expose a projection cut. Preserve their historical
  // whole-snapshot behavior; versioned Alpha/rc.6 payloads always carry one and
  // use the per-key higher-sequence path below.
  if (sequence === undefined) return { ...projections, [sessionId]: values }

  const current = projections[sessionId]
  const next = { ...(current ?? {}) }
  const previousBaseline = projectionSequences?.baselines.get(sessionId)
  if (previousBaseline !== undefined && sequence <= previousBaseline) return projections
  if (projectionSequences !== undefined) projectionSequences.baselines.set(sessionId, sequence)
  let changed = false
  for (const [key, value] of Object.entries(values)) {
    const previous = projectionSequences?.perKey.get(sessionId)?.get(key)
    if (previous !== undefined && sequence <= previous) continue
    if (projectionSequences !== undefined) {
      const perSession = projectionSequences.perKey.get(sessionId) ?? new Map<string, number>()
      perSession.set(key, sequence)
      projectionSequences.perKey.set(sessionId, perSession)
    }
    if (current === undefined || !Object.hasOwn(current, key) || !Object.is(current[key], value)) {
      next[key] = value
      changed = true
    }
  }
  // A complete baseline also carries absence information. Keep a tombstone
  // watermark for an omitted key so a delayed lower-sequence frame cannot
  // resurrect a value that the newer snapshot has removed.
  const knownKeys = new Set([
    ...Object.keys(current ?? {}),
    ...(projectionSequences?.perKey.get(sessionId)?.keys() ?? []),
  ])
  for (const key of knownKeys) {
    if (Object.hasOwn(values, key)) continue
    const previous = projectionSequences?.perKey.get(sessionId)?.get(key)
    if (previous !== undefined && sequence <= previous) continue
    if (projectionSequences !== undefined) {
      const perSession = projectionSequences.perKey.get(sessionId) ?? new Map<string, number>()
      perSession.set(key, sequence)
      projectionSequences.perKey.set(sessionId, perSession)
    }
    delete next[key]
    changed = true
  }
  return changed ? { ...projections, [sessionId]: next } : projections
}

function setSessionProjectionBaseline(
  baseline: Readonly<Record<string, SessionProjectionSnapshot>>,
  projectionSequences?: ProjectionSequenceIndex,
): AppState['projections'] {
  const projections = Object.fromEntries(
    Object.entries(baseline).map(([sessionId, projection]) => [sessionId, projection.values]),
  )
  projectionSequences?.perKey.clear()
  projectionSequences?.baselines.clear()
  for (const [sessionId, projection] of Object.entries(baseline)) {
    projectionSequences?.baselines.set(sessionId, projection.asOfSequence)
    projectionSequences?.perKey.set(
      sessionId,
      new Map(Object.keys(projection.values).map((key) => [key, projection.asOfSequence])),
    )
  }
  return projections
}

function applySessionProjectionPresentation(
  current: AppState,
  sessionId: string,
  key: string,
  value: unknown,
): AppState {
  let next = current
  if (sessionId === next.activeSessionId && next.configuration !== undefined) {
    const projection = object(value)
    const configuration = next.configuration
    if (key === 'plan' && typeof projection?.active === 'boolean')
      next = {
        ...next,
        configuration: { ...configuration, planMode: projection.active, planModeKnown: true },
      }
    if (
      key === 'permissions' &&
      typeof projection?.currentValue === 'string' &&
      projection.currentValue.trim() !== ''
    )
      next = {
        ...next,
        configuration: {
          ...configuration,
          permissionPreset: projection.currentValue,
          permissionPresetKnown: true,
        },
      }
  }
  if (key === 'title' && typeof value === 'string') {
    const title = value.trim()
    if (title !== '') {
      const sessions = updateSessionById(next.sessions, sessionId, (session) =>
        !session.blank && session.title !== title ? { ...session, title } : session,
      )
      if (sessions !== next.sessions) next = { ...next, sessions }
    }
  }
  return next
}

function updateSessionProjection(
  projections: AppState['projections'],
  sessionId: string,
  key: string,
  value: unknown,
  sequence?: number,
  projectionSequences?: ProjectionSequenceIndex,
): AppState['projections'] {
  if (!acceptProjectionSequence(projectionSequences, sessionId, key, sequence)) return projections
  const current = projections[sessionId]
  if (current !== undefined && Object.hasOwn(current, key) && Object.is(current[key], value))
    return projections
  return {
    ...projections,
    [sessionId]: { ...(current ?? {}), [key]: value },
  }
}

function projectionAsOfSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1 ? value : undefined
}

function acceptProjectionSequence(
  projectionSequences: ProjectionSequenceIndex | undefined,
  sessionId: string,
  key: string,
  sequence: number | undefined,
): boolean {
  if (projectionSequences === undefined || sequence === undefined) return true
  const baseline = projectionSequences.baselines.get(sessionId)
  if (baseline !== undefined && sequence <= baseline) return false
  const perSession = projectionSequences.perKey.get(sessionId) ?? new Map<string, number>()
  const previous = perSession.get(key)
  if (previous !== undefined && sequence <= previous) return false
  perSession.set(key, sequence)
  projectionSequences.perKey.set(sessionId, perSession)
  return true
}

function currentProjectionSequence(
  projectionSequences: ProjectionSequenceIndex | undefined,
  sessionId: string,
  key: string,
  sequence: number | undefined,
): boolean {
  if (projectionSequences === undefined || sequence === undefined) return true
  const baseline = projectionSequences.baselines.get(sessionId)
  if (baseline !== undefined && sequence <= baseline) return false
  const previous = projectionSequences.perKey.get(sessionId)?.get(key)
  return previous === undefined || sequence > previous
}

function removeSessionProjection(
  projections: AppState['projections'],
  sessionId: string,
): AppState['projections'] {
  const remaining = { ...projections }
  delete remaining[sessionId]
  return remaining
}

/**
 * Every session-scoped view state describes the conversation that is no
 * longer open: leaving any of it behind would show one session's history,
 * queue, or catalogs under the next row the user opens.
 */
function clearedActiveSession(current: AppState, sessionId: string): Partial<AppState> {
  return {
    activeSessionId: undefined,
    timeline: {
      sessionId: undefined,
      nodes: [],
      lastSequence: -1,
      nodeChangeStart: 0,
      eventCount: 0,
    },
    history: [],
    historyHasMore: false,
    historyBeforeSequence: undefined,
    historyLoading: false,
    projections: removeSessionProjection(current.projections, sessionId),
    configuration: undefined,
    sessionModels: [],
    sessionModelFailures: [],
    sessionModelCurrent: undefined,
    sessionModelRoutable: undefined,
    sessionModelDirectoryLoading: false,
    sessionModelDirectoryError: undefined,
    permissionPresets: [],
    queue: [],
    goals: [],
    todos: [],
    jobs: [],
    jobFollow: undefined,
    feedback: {},
    feedbackUnavailable: false,
    subagents: EMPTY_SUBAGENT_CATALOG,
    activeSubagent: undefined,
    commands: [],
  }
}

function domainEvent(name: string, payload: unknown): BackendEvent | undefined {
  const raw = object(payload)
  if (raw !== undefined && raw.sequence !== undefined && finiteEventSequence(raw.sequence) === undefined)
    return {
      type: 'unknown',
      ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
      name,
      payload,
    }
  const event = parseDomainEvent(name, payload)
  if (event === undefined) return undefined
  const sequence = finiteEventSequence(object(payload)?.sequence)
  return sequence === undefined ? event : { ...event, sequence }
}

function parseDomainEvent(name: string, payload: unknown): BackendEvent | undefined {
  const value = object(payload)
  if (value === undefined) return { type: 'unknown', name, payload }
  if (name === 'session.system' && nonEmptyString(value.sessionId))
    return { type: 'session.system', sessionId: value.sessionId }
  if (
    name === 'message.user' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.messageId) &&
    typeof value.markdown === 'string'
  ) {
    const hasAttachments = Object.hasOwn(value, 'attachments')
    const hasImages = Object.hasOwn(value, 'images')
    const hasSessionReferenceLabels = Object.hasOwn(value, 'sessionReferenceLabels')
    const attachments = hasAttachments ? messageAttachments(value.attachments) : undefined
    const images = hasImages ? messageImages(value.images) : undefined
    const sessionReferenceLabels = hasSessionReferenceLabels
      ? messageSessionReferenceLabels(value.sessionReferenceLabels)
      : undefined
    if (
      (hasAttachments && attachments === undefined) ||
      (hasImages && images === undefined) ||
      (hasSessionReferenceLabels && sessionReferenceLabels === undefined) ||
      (value.rpcId !== undefined && typeof value.rpcId !== 'string') ||
      (value.source !== undefined && typeof value.source !== 'string') ||
      (value.sourceForm !== undefined && typeof value.sourceForm !== 'string') ||
      (value.sourceSummary !== undefined && typeof value.sourceSummary !== 'string')
    )
      return { type: 'unknown', name, payload }
    return {
      type: 'message.user',
      sessionId: value.sessionId,
      messageId: value.messageId,
      markdown: value.markdown,
      ...(attachments === undefined ? {} : { attachments }),
      ...(images === undefined ? {} : { images }),
      ...(typeof value.rpcId === 'string' ? { rpcId: value.rpcId } : {}),
      ...(typeof value.source === 'string' ? { source: value.source } : {}),
      ...(typeof value.sourceForm === 'string' ? { sourceForm: value.sourceForm } : {}),
      ...(typeof value.sourceSummary === 'string' ? { sourceSummary: value.sourceSummary } : {}),
      ...(sessionReferenceLabels === undefined ? {} : { sessionReferenceLabels }),
    }
  }
  if ((name === 'turn.started' || name === 'turn.ended') && nonEmptyString(value.sessionId)) {
    const turn = finiteEventIndex(value.turn)
    if (turn === undefined) return { type: 'unknown', name, payload }
    if (name === 'turn.started') return { type: 'turn.started', sessionId: value.sessionId, turn }
    const hasFailure = Object.hasOwn(value, 'failure')
    const failure = turnEndFailure(value.failure ?? value.reason)
    if (hasFailure && failure === undefined) return { type: 'unknown', name, payload }
    return {
      type: 'turn.ended',
      sessionId: value.sessionId,
      turn,
      reason: turnEndReason(value.reason),
      ...(failure === undefined ? {} : { failure }),
    }
  }
  if ((name === 'step.started' || name === 'step.ended') && nonEmptyString(value.sessionId)) {
    const turn = finiteEventIndex(value.turn)
    const step = finiteEventIndex(value.step)
    if (turn === undefined || step === undefined) return { type: 'unknown', name, payload }
    const time = finiteEventTimestamp(value.time)
    if (value.time !== undefined && time === undefined) return { type: 'unknown', name, payload }
    return name === 'step.started'
      ? {
          type: 'step.started',
          sessionId: value.sessionId,
          turn,
          step,
          ...(time === undefined ? {} : { time }),
        }
      : {
          type: 'step.ended',
          sessionId: value.sessionId,
          turn,
          step,
          ...(time === undefined ? {} : { time }),
        }
  }
  if (
    name === 'message.delta' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.messageId) &&
    typeof value.delta === 'string'
  ) {
    const turn = finiteEventIndex(value.turn)
    const step = finiteEventIndex(value.step)
    const time = finiteEventTimestamp(value.time)
    const transientSequence = finiteTransientSequence(value.transientSequence)
    const transientIndex = finiteEventIndex(value.transientIndex)
    const transientStartedAfterSequence = finiteTransientStartSequence(value.transientStartedAfterSequence)
    const hasTransientMetadata =
      value.transientSequence !== undefined ||
      value.transientAttemptId !== undefined ||
      value.transientIndex !== undefined ||
      value.transientStartedAfterSequence !== undefined
    if (
      (value.turn !== undefined && turn === undefined) ||
      (value.step !== undefined && step === undefined) ||
      (value.time !== undefined && time === undefined) ||
      (hasTransientMetadata &&
        (transientSequence === undefined ||
          !nonEmptyString(value.transientAttemptId) ||
          transientIndex === undefined)) ||
      (value.transientStartedAfterSequence !== undefined && transientStartedAfterSequence === undefined) ||
      (Object.hasOwn(value, 'interrupted') && value.interrupted !== true)
    )
      return { type: 'unknown', name, payload }
    return {
      type: 'message.delta',
      sessionId: value.sessionId,
      messageId: value.messageId,
      delta: value.delta,
      ...(turn === undefined ? {} : { turn }),
      ...(step === undefined ? {} : { step }),
      ...(time === undefined ? {} : { time }),
      ...(transientSequence === undefined ? {} : { transientSequence }),
      ...(typeof value.transientAttemptId === 'string'
        ? { transientAttemptId: value.transientAttemptId }
        : {}),
      ...(transientIndex === undefined ? {} : { transientIndex }),
      ...(transientStartedAfterSequence === undefined ? {} : { transientStartedAfterSequence }),
      ...(value.interrupted === true ? { interrupted: true as const } : {}),
    }
  }
  if (
    name === 'reasoning.delta' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.messageId) &&
    typeof value.delta === 'string'
  ) {
    const turn = finiteEventIndex(value.turn)
    const step = finiteEventIndex(value.step)
    const time = finiteEventTimestamp(value.time)
    const transientSequence = finiteTransientSequence(value.transientSequence)
    const transientIndex = finiteEventIndex(value.transientIndex)
    const transientStartedAfterSequence = finiteTransientStartSequence(value.transientStartedAfterSequence)
    const hasTransientMetadata =
      value.transientSequence !== undefined ||
      value.transientAttemptId !== undefined ||
      value.transientIndex !== undefined ||
      value.transientStartedAfterSequence !== undefined
    if (
      (value.turn !== undefined && turn === undefined) ||
      (value.step !== undefined && step === undefined) ||
      (value.time !== undefined && time === undefined) ||
      (hasTransientMetadata &&
        (transientSequence === undefined ||
          !nonEmptyString(value.transientAttemptId) ||
          transientIndex === undefined)) ||
      (value.transientStartedAfterSequence !== undefined && transientStartedAfterSequence === undefined) ||
      (Object.hasOwn(value, 'interrupted') && value.interrupted !== true)
    )
      return { type: 'unknown', name, payload }
    return {
      type: 'reasoning.delta',
      sessionId: value.sessionId,
      messageId: value.messageId,
      delta: value.delta,
      ...(turn === undefined ? {} : { turn }),
      ...(step === undefined ? {} : { step }),
      ...(time === undefined ? {} : { time }),
      ...(transientSequence === undefined ? {} : { transientSequence }),
      ...(typeof value.transientAttemptId === 'string'
        ? { transientAttemptId: value.transientAttemptId }
        : {}),
      ...(transientIndex === undefined ? {} : { transientIndex }),
      ...(transientStartedAfterSequence === undefined ? {} : { transientStartedAfterSequence }),
    }
  }
  if (name === 'message.completed' && nonEmptyString(value.sessionId) && nonEmptyString(value.messageId)) {
    const usage = parseTokenUsage(value.usage)
    const hasImages = Object.hasOwn(value, 'images')
    const images = hasImages ? messageImages(value.images) : undefined
    const turn = finiteEventIndex(value.turn)
    const step = finiteEventIndex(value.step)
    const time = finiteEventTimestamp(value.time)
    if (
      (hasImages && images === undefined) ||
      (Object.hasOwn(value, 'interrupted') && value.interrupted !== true) ||
      (value.markdown !== undefined && typeof value.markdown !== 'string') ||
      (value.reasoning !== undefined && typeof value.reasoning !== 'string') ||
      (value.modelLabel !== undefined && typeof value.modelLabel !== 'string') ||
      (value.turn !== undefined && turn === undefined) ||
      (value.step !== undefined && step === undefined) ||
      (value.time !== undefined && time === undefined)
    )
      return { type: 'unknown', name, payload }
    return {
      type: 'message.completed',
      sessionId: value.sessionId,
      messageId: value.messageId,
      ...(typeof value.markdown === 'string' ? { markdown: value.markdown } : {}),
      ...(typeof value.reasoning === 'string' ? { reasoning: value.reasoning } : {}),
      ...(typeof value.modelLabel === 'string' ? { modelLabel: value.modelLabel } : {}),
      ...(images === undefined ? {} : { images }),
      ...(usage === undefined ? {} : { usage }),
      ...(turn === undefined ? {} : { turn }),
      ...(step === undefined ? {} : { step }),
      ...(time === undefined ? {} : { time }),
      ...(value.interrupted === true ? { interrupted: true as const } : {}),
    }
  }
  if (name === 'assistant.attempt' && nonEmptyString(value.sessionId)) {
    const turn = finiteEventIndex(value.turn)
    const step = finiteEventIndex(value.step)
    const time = finiteEventTimestamp(value.time)
    if (turn === undefined || step === undefined || (value.time !== undefined && time === undefined))
      return { type: 'unknown', name, payload }
    return {
      type: 'assistant.attempt',
      sessionId: value.sessionId,
      turn,
      step,
      ...(time === undefined ? {} : { time }),
    }
  }
  if (name === 'deliverables.presented' && nonEmptyString(value.sessionId)) {
    const turn = positivePresentationNumber(value.turn)
    const callId = presentationIdentifier(value.callId)
    const files = parsePresentedFiles(value.files)
    if (turn !== undefined && callId !== undefined && files !== undefined)
      return {
        type: 'deliverables.presented',
        sessionId: value.sessionId,
        turn,
        callId,
        files,
      }
  }
  if (name === 'subagent.catalog.updated' && nonEmptyString(value.sessionId)) {
    const entry = parseSubagentCatalogEntryFact(value.entry)
    if (entry !== undefined) return { type: 'subagent.catalog.updated', sessionId: value.sessionId, entry }
  }
  if (name === 'session.status' && nonEmptyString(value.sessionId) && typeof value.status === 'string')
    return { type: 'session.status', sessionId: value.sessionId, status: value.status }
  if (
    name === 'session.activity' &&
    nonEmptyString(value.sessionId) &&
    typeof value.updatedAt === 'number' &&
    Number.isSafeInteger(value.updatedAt) &&
    value.updatedAt >= 0
  )
    return { type: 'session.activity', sessionId: value.sessionId, updatedAt: value.updatedAt }
  if (
    name === 'session.subscribed' &&
    nonEmptyString(value.sessionId) &&
    typeof value.lastSequence === 'number' &&
    Number.isSafeInteger(value.lastSequence) &&
    value.lastSequence >= -1
  ) {
    const hasProjection = Object.hasOwn(value, 'projection')
    let projection: SessionProjectionSnapshot | undefined
    if (hasProjection) {
      try {
        projection = parseSessionProjection(value.projection)
      } catch {
        return { type: 'unknown', name, payload }
      }
    }
    if (hasProjection && projection === undefined) return { type: 'unknown', name, payload }
    if (value.controlBaseline !== undefined && typeof value.controlBaseline !== 'boolean')
      return { type: 'unknown', name, payload }
    return {
      type: 'session.subscribed',
      sessionId: value.sessionId,
      lastSequence: value.lastSequence,
      ...(value.controlBaseline === undefined ? {} : { controlBaseline: value.controlBaseline }),
      ...(projection === undefined ? {} : { projection }),
    }
  }
  if (name === 'session.title' && nonEmptyString(value.sessionId) && typeof value.title === 'string')
    return { type: 'session.title', sessionId: value.sessionId, title: value.title }
  if (name === 'session.configuration' && nonEmptyString(value.sessionId) && isRecord(value.patch)) {
    const patch = configurationPatch(value.patch)
    if (patch !== undefined) return { type: 'session.configuration', sessionId: value.sessionId, patch }
  }
  if (name === 'session.added' && nonEmptyString(value.sessionId)) {
    const hasParentSessionId = Object.hasOwn(value, 'parentSessionId')
    const hasOrigin = Object.hasOwn(value, 'origin')
    const hasCwd = Object.hasOwn(value, 'cwd')
    const hasAgentPreset = Object.hasOwn(value, 'agentPreset')
    if (
      typeof value.blank !== 'boolean' ||
      (Object.hasOwn(value, 'agentAvailable') && typeof value.agentAvailable !== 'boolean') ||
      (hasParentSessionId &&
        (typeof value.parentSessionId !== 'string' || value.parentSessionId.trim() === '')) ||
      (hasOrigin && value.origin !== 'subagent') ||
      (hasCwd && typeof value.cwd !== 'string') ||
      (hasAgentPreset && typeof value.agentPreset !== 'string')
    )
      return { type: 'unknown', name, payload }
    return {
      type: 'session.added',
      sessionId: value.sessionId,
      blank: value.blank,
      ...(typeof value.agentAvailable === 'boolean' ? { agentAvailable: value.agentAvailable } : {}),
      ...(typeof value.parentSessionId === 'string' ? { parentSessionId: value.parentSessionId } : {}),
      ...(value.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
      ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
      ...(typeof value.agentPreset === 'string' ? { agentPreset: value.agentPreset } : {}),
    }
  }
  if (name === 'session.removed' && nonEmptyString(value.sessionId))
    return { type: 'session.removed', sessionId: value.sessionId }
  if (name === 'session.projection.baseline') {
    const rawProjections = object(value.projections)
    if (rawProjections === undefined) return { type: 'unknown', name, payload }
    const projections: Record<string, SessionProjectionSnapshot> = Object.create(null) as Record<
      string,
      SessionProjectionSnapshot
    >
    for (const [sessionId, rawProjection] of Object.entries(rawProjections)) {
      if (!nonEmptyString(sessionId)) return { type: 'unknown', name, payload }
      try {
        const projection = parseSessionProjection(rawProjection)
        if (projection === undefined) return { type: 'unknown', name, payload }
        projections[sessionId] = projection
      } catch {
        return { type: 'unknown', name, payload }
      }
    }
    return { type: 'session.projection.baseline', projections }
  }
  if (
    name === 'session.projection' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.key) &&
    Object.hasOwn(value, 'value')
  )
    return { type: 'session.projection', sessionId: value.sessionId, key: value.key, value: value.value }
  if (
    name === 'tool.updated' &&
    nonEmptyString(value.sessionId) &&
    isRecord(value.tool) &&
    typeof value.tool.id === 'string' &&
    value.tool.id.trim() !== '' &&
    typeof value.tool.name === 'string' &&
    value.tool.name.trim() !== '' &&
    isToolStatus(value.tool.status)
  ) {
    const turn = finiteEventIndex(value.tool.turn)
    const step = finiteEventIndex(value.tool.step)
    const parentCallId = value.tool.parentCallId
    const locations = parseToolLocations(value.tool.locations)
    const presentation = parseToolPresentation(value.tool.presentation)
    const images = value.tool.images === undefined ? undefined : messageImages(value.tool.images)
    if (
      (value.tool.images !== undefined && images === undefined) ||
      (value.tool.turn !== undefined && turn === undefined) ||
      (value.tool.step !== undefined && step === undefined) ||
      (parentCallId !== undefined && !nonEmptyString(parentCallId)) ||
      (value.tool.category !== undefined && typeof value.tool.category !== 'string') ||
      (value.tool.title !== undefined && typeof value.tool.title !== 'string') ||
      (value.tool.startedAt !== undefined && typeof value.tool.startedAt !== 'string') ||
      (value.tool.completedAt !== undefined && typeof value.tool.completedAt !== 'string') ||
      (value.tool.inputSummary !== undefined && typeof value.tool.inputSummary !== 'string') ||
      (value.tool.outputSummary !== undefined && typeof value.tool.outputSummary !== 'string') ||
      (value.tool.error !== undefined && typeof value.tool.error !== 'string') ||
      (value.tool.metadata !== undefined && !isRecord(value.tool.metadata))
    )
      return { type: 'unknown', name, payload }
    return {
      type: 'tool.updated',
      sessionId: value.sessionId,
      tool: {
        id: value.tool.id,
        ...(typeof parentCallId === 'string' ? { parentCallId } : {}),
        ...(turn === undefined ? {} : { turn }),
        ...(step === undefined ? {} : { step }),
        name: value.tool.name,
        category: typeof value.tool.category === 'string' ? value.tool.category : 'tool',
        title: typeof value.tool.title === 'string' ? value.tool.title : value.tool.name,
        status: value.tool.status,
        ...(typeof value.tool.startedAt === 'string' ? { startedAt: value.tool.startedAt } : {}),
        ...(typeof value.tool.completedAt === 'string' ? { completedAt: value.tool.completedAt } : {}),
        ...(isRecord(value.tool.submittedPlan) &&
        typeof value.tool.submittedPlan.title === 'string' &&
        typeof value.tool.submittedPlan.markdown === 'string'
          ? {
              submittedPlan: {
                title: value.tool.submittedPlan.title,
                markdown: value.tool.submittedPlan.markdown,
              },
            }
          : {}),
        ...(typeof value.tool.inputSummary === 'string' ? { inputSummary: value.tool.inputSummary } : {}),
        ...(typeof value.tool.outputSummary === 'string' ? { outputSummary: value.tool.outputSummary } : {}),
        ...(typeof value.tool.error === 'string' ? { error: value.tool.error } : {}),
        ...(locations === undefined ? {} : { locations }),
        ...(presentation === undefined ? {} : { presentation }),
        ...(images === undefined ? {} : { images }),
        metadata: isRecord(value.tool.metadata) ? value.tool.metadata : {},
      },
    }
  }
  if (name === 'team.updated' && nonEmptyString(value.sessionId)) {
    const activity = parseTeamActivity(value.activity)
    return activity === undefined
      ? { type: 'unknown', sessionId: value.sessionId, name, payload }
      : { type: 'team.updated', sessionId: value.sessionId, activity }
  }
  if (name === 'goal.updated' && nonEmptyString(value.sessionId)) {
    const goals = parseGoalViews(value.goals)
    if (goals !== undefined) return { type: 'goal.updated', sessionId: value.sessionId, goals }
  }
  if (name === 'todo.updated' && nonEmptyString(value.sessionId)) {
    const todos = parseTodoViews(value.todos)
    if (todos !== undefined) return { type: 'todo.updated', sessionId: value.sessionId, todos }
  }
  if (
    name === 'compaction.updated' &&
    nonEmptyString(value.sessionId) &&
    isRecord(value.compaction) &&
    nonEmptyString(value.compaction.id)
  ) {
    const phase = value.compaction.phase
    const summary = value.compaction.summary
    const replacedCount = value.compaction.replacedCount
    const estimatedTokens = value.compaction.estimatedTokens
    const parsedReplacedCount = nonNegativeSafeInteger(replacedCount)
    const parsedEstimatedTokens = nonNegativeSafeInteger(estimatedTokens)
    if (
      (phase !== 'start' && phase !== 'summary' && phase !== 'prune' && phase !== 'end') ||
      (summary !== undefined && typeof summary !== 'string') ||
      (replacedCount !== undefined && parsedReplacedCount === undefined) ||
      (estimatedTokens !== undefined && parsedEstimatedTokens === undefined)
    )
      return { type: 'unknown', sessionId: value.sessionId, name, payload }
    return {
      type: 'compaction.updated',
      sessionId: value.sessionId,
      compaction: {
        id: value.compaction.id,
        phase,
        ...(summary === undefined ? {} : { summary }),
        ...(parsedReplacedCount === undefined ? {} : { replacedCount: parsedReplacedCount }),
        ...(parsedEstimatedTokens === undefined ? {} : { estimatedTokens: parsedEstimatedTokens }),
      },
    }
  }
  if (name === 'model.retry' && isRecord(value.retry)) {
    const retry = value.retry
    const turn = finiteEventIndex(retry.turn)
    const step = finiteEventIndex(retry.step)
    const attempt = positiveSafeInteger(retry.attempt)
    const delayMs = retry.delayMs === undefined ? undefined : nonNegativeSafeInteger(retry.delayMs)
    const maxRetries = retry.maxRetries === undefined ? undefined : positiveSafeInteger(retry.maxRetries)
    if (
      nonEmptyString(retry.sessionId) &&
      nonEmptyString(retry.id) &&
      turn !== undefined &&
      step !== undefined &&
      attempt !== undefined &&
      (retry.delayMs === undefined || delayMs !== undefined) &&
      (retry.maxRetries === undefined || maxRetries !== undefined) &&
      (retry.message === undefined || typeof retry.message === 'string') &&
      (retry.state === 'scheduled' || retry.state === 'started')
    )
      return {
        type: 'model.retry',
        retry: {
          sessionId: retry.sessionId,
          id: retry.id,
          turn,
          step,
          attempt,
          state: retry.state,
          ...(delayMs === undefined ? {} : { delayMs }),
          ...(maxRetries === undefined ? {} : { maxRetries }),
          ...(typeof retry.message === 'string' ? { message: retry.message } : {}),
        },
      }
  }
  if (
    name === 'jobs.updated' &&
    nonEmptyString(value.sessionId) &&
    Array.isArray(value.jobs) &&
    value.jobs.every(isJobView)
  ) {
    return {
      type: 'jobs.updated',
      sessionId: value.sessionId,
      jobs: value.jobs,
    }
  }
  if (name === 'job.follow.updated' && nonEmptyString(value.sessionId) && nonEmptyString(value.jobId)) {
    const frame = parseJobFollowFrame(value.frame)
    if (frame !== undefined)
      return { type: 'job.follow.updated', sessionId: value.sessionId, jobId: value.jobId, frame }
  }
  if (name === 'queue.updated' && nonEmptyString(value.sessionId)) {
    const items = parseQueuedInputs(value.items, value.sessionId)
    if (items !== undefined) return { type: 'queue.updated', sessionId: value.sessionId, items }
  }
  if (name === 'workflow.started' && nonEmptyString(value.sessionId) && isWorkflowSummary(value.workflow))
    return {
      type: 'workflow.started',
      sessionId: value.sessionId,
      workflow: value.workflow,
    }
  if (
    name === 'workflow.member.started' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.runId) &&
    (typeof value.phase === 'string' || value.phase === null) &&
    isWorkflowMember(value.member) &&
    value.member.status === 'running'
  )
    return {
      type: 'workflow.member.started',
      sessionId: value.sessionId,
      runId: value.runId,
      phase: value.phase,
      member: value.member,
    }
  if (
    name === 'workflow.member.ended' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.runId) &&
    Number.isSafeInteger(value.seq) &&
    (value.seq as number) > 0 &&
    (value.outcome === 'completed' || value.outcome === 'failed' || value.outcome === 'cancelled')
  )
    return {
      type: 'workflow.member.ended',
      sessionId: value.sessionId,
      runId: value.runId,
      seq: value.seq as number,
      outcome: value.outcome,
    }
  if (
    name === 'workflow.ended' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.runId) &&
    (value.stopReason === 'completed' || value.stopReason === 'cancelled' || value.stopReason === 'error')
  )
    return {
      type: 'workflow.ended',
      sessionId: value.sessionId,
      runId: value.runId,
      stopReason: value.stopReason,
    }
  if (name === 'permission.requested' && isRecord(value.request)) {
    const request = parsePermissionRequest(value.request)
    if (request !== undefined) return { type: 'permission.requested', request }
  }
  if (name === 'question.requested' && isRecord(value.question)) {
    const question = parseUserQuestion(value.question)
    if (question !== undefined) return { type: 'question.requested', question }
  }
  if (name === 'permission.resolved') {
    const hasOutcome = Object.hasOwn(value, 'outcome')
    if (
      nonEmptyString(value.sessionId) &&
      nonEmptyString(value.requestId) &&
      (!hasOutcome || typeof value.outcome === 'string')
    )
      return {
        type: 'permission.resolved',
        sessionId: value.sessionId,
        requestId: value.requestId,
        ...(typeof value.outcome === 'string' ? { outcome: value.outcome } : {}),
      }
  }
  if (name === 'question.resolved') {
    const hasQuestionRpcId = Object.hasOwn(value, 'questionRpcId')
    const hasQuestionId = Object.hasOwn(value, 'questionId')
    const questionRpcId =
      hasQuestionRpcId && nonEmptyString(value.questionRpcId) ? value.questionRpcId : undefined
    const questionId = hasQuestionId && nonEmptyString(value.questionId) ? value.questionId : undefined
    const hasOutcome = Object.hasOwn(value, 'outcome')
    if (
      nonEmptyString(value.sessionId) &&
      (!hasQuestionRpcId || questionRpcId !== undefined) &&
      (!hasQuestionId || questionId !== undefined) &&
      (questionRpcId !== undefined || questionId !== undefined) &&
      (!hasOutcome || typeof value.outcome === 'string')
    )
      return {
        type: 'question.resolved',
        sessionId: value.sessionId,
        ...(questionRpcId === undefined ? {} : { questionRpcId }),
        ...(questionId === undefined ? {} : { questionId }),
        ...(typeof value.outcome === 'string' ? { outcome: value.outcome } : {}),
      }
  }
  if (name === 'workspace.changed') {
    const hasWorkspaceId = Object.hasOwn(value, 'workspaceId')
    const workspaceId = hasWorkspaceId && nonEmptyString(value.workspaceId) ? value.workspaceId : undefined
    if (hasWorkspaceId && workspaceId === undefined) return { type: 'unknown', name, payload }
    return {
      type: 'workspace.changed',
      ...(workspaceId === undefined ? {} : { workspaceId }),
    }
  }
  if (name === 'workspace.removed') {
    const hasWorkspaceId = Object.hasOwn(value, 'workspaceId')
    const workspaceId = hasWorkspaceId && nonEmptyString(value.workspaceId) ? value.workspaceId : undefined
    if (hasWorkspaceId && workspaceId === undefined) return { type: 'unknown', name, payload }
    return {
      type: 'workspace.removed',
      ...(workspaceId === undefined ? {} : { workspaceId }),
    }
  }
  if (
    name === 'workspace.order.changed' &&
    Array.isArray(value.workspaceIds) &&
    value.workspaceIds.every((entry) => nonEmptyString(entry))
  )
    return {
      type: 'workspace.order.changed',
      workspaceIds: value.workspaceIds,
    }
  if (
    name === 'archived.sessions.changed' &&
    Array.isArray(value.sessionIds) &&
    value.sessionIds.every((entry) => nonEmptyString(entry))
  )
    return {
      type: 'archived.sessions.changed',
      sessionIds: value.sessionIds,
    }
  if (
    name === 'session.gap' &&
    nonEmptyString(value.sessionId) &&
    typeof value.fromSequence === 'number' &&
    Number.isSafeInteger(value.fromSequence) &&
    value.fromSequence >= 0 &&
    typeof value.toSequence === 'number' &&
    Number.isSafeInteger(value.toSequence) &&
    value.toSequence >= value.fromSequence
  )
    return {
      type: 'session.gap',
      sessionId: value.sessionId,
      fromSequence: value.fromSequence,
      toSequence: value.toSequence,
    }
  if (name === 'remote.event' && nonEmptyString(value.name) && Array.isArray(value.args))
    return { type: 'remote.event', name: value.name, args: value.args }
  if (name === 'unknown')
    return {
      type: 'unknown',
      ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
      name: typeof value.name === 'string' ? value.name : 'unknown',
      payload: value.payload,
    }
  if (
    name === 'notice' &&
    typeof value.text === 'string' &&
    (value.level === 'info' || value.level === 'warning' || value.level === 'error')
  ) {
    const hasSessionId = Object.hasOwn(value, 'sessionId')
    const hasCommandName = Object.hasOwn(value, 'commandName')
    const hasCommandId = Object.hasOwn(value, 'commandId')
    const hasCommandPhase = Object.hasOwn(value, 'commandPhase')
    const hasCommandInput = Object.hasOwn(value, 'commandInput')
    if (
      (hasSessionId && !nonEmptyString(value.sessionId)) ||
      (hasCommandName && !nonEmptyString(value.commandName)) ||
      (hasCommandId && !nonEmptyString(value.commandId)) ||
      (hasCommandPhase && value.commandPhase !== 'run' && value.commandPhase !== 'done') ||
      (hasCommandInput && !nonEmptyString(value.commandInput))
    )
      return { type: 'unknown', name, payload }
    return {
      type: 'notice',
      ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
      level: value.level,
      text: value.text,
      ...(typeof value.commandName === 'string' && value.commandName.trim() !== ''
        ? { commandName: value.commandName.slice(0, 128) }
        : {}),
      ...(typeof value.commandId === 'string' && value.commandId.trim() !== ''
        ? { commandId: value.commandId.slice(0, 256) }
        : {}),
      ...(value.commandPhase === 'run' || value.commandPhase === 'done'
        ? { commandPhase: value.commandPhase }
        : {}),
      // The host logs `command/run.args` verbatim with no length bound, and this
      // becomes the transcript's command-input row — the only record of the line
      // that ran, so it must not be clipped here either.
      ...(typeof value.commandInput === 'string' && value.commandInput.trim() !== ''
        ? { commandInput: value.commandInput }
        : {}),
    }
  }
  if (name === 'connection.lost' && typeof value.reason === 'string')
    return { type: 'connection.lost', reason: value.reason }
  return {
    type: 'unknown',
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
    name,
    payload,
  }
}

interface ParsedHistoryPayload {
  readonly history: readonly SessionHistoryEvent[]
  readonly timeline: readonly HydratedTimelineEntry[]
}

interface HydratedTimelineEntry {
  readonly event: BackendEvent
  readonly sequence: number
}

function parseSessionHistory(value: unknown): readonly SessionHistoryEvent[] {
  return parseHistoryPayload(value, false).history
}

/**
 * Parse the ordinary session-open payload once for both durable history and
 * timeline hydration. Malformed wrapped entries still become visible unknown
 * timeline records, matching the defensive behavior of the old two-pass path.
 */
function parseSessionHistoryWithTimeline(value: unknown): ParsedHistoryPayload {
  return parseHistoryPayload(value, true)
}

function parseHistoryPayload(value: unknown, includeTimeline: boolean): ParsedHistoryPayload {
  if (!Array.isArray(value)) return { history: [], timeline: [] }
  const history: SessionHistoryEvent[] = []
  const timeline: HydratedTimelineEntry[] = []
  for (const [index, entry] of value.entries()) {
    const record = object(entry)
    if (record === undefined) {
      if (includeTimeline)
        timeline.push({
          event: { type: 'unknown', name: 'history/invalid-entry', payload: { index } },
          sequence: index,
        })
      continue
    }
    const eventRecord = object(record.event)
    const historyEventRecord = eventRecord ?? record
    const coveredSequences = parseCoveredSequences(record)
    const hasRecordSequence = Object.hasOwn(record, 'sequence')
    const hasEventSequence = Object.hasOwn(historyEventRecord, 'sequence')
    const hasEventSeq = Object.hasOwn(historyEventRecord, 'seq')
    const hasRecordTime = Object.hasOwn(record, 'time')
    const recordTimeValue = record.time
    const recordTime = hasRecordTime && nonEmptyString(recordTimeValue) ? recordTimeValue : undefined
    const rawSequence = hasRecordSequence
      ? record.sequence
      : hasEventSequence
        ? historyEventRecord.sequence
        : hasEventSeq
          ? historyEventRecord.seq
          : undefined
    const hasExplicitSequence = hasRecordSequence || hasEventSequence || hasEventSeq
    if (hasExplicitSequence && optionalSequence(rawSequence) === undefined)
      throw new Error(translate('app.error.malformedHistory'))
    if (hasRecordTime && !nonEmptyString(recordTime)) throw new Error(translate('app.error.malformedHistory'))
    const sequence = optionalSequence(rawSequence) ?? index
    if (
      coveredSequences !== undefined &&
      (coveredSequences.length === 0 || coveredSequences[coveredSequences.length - 1] !== sequence)
    )
      throw new Error(translate('app.error.malformedHistory'))
    const parsedEvent =
      typeof historyEventRecord?.type === 'string'
        ? domainEvent(historyEventRecord.type, historyEventRecord)
        : undefined
    if (parsedEvent !== undefined) {
      history.push({
        sequence,
        time: recordTime === undefined ? historyTime(parsedEvent) : recordTime,
        event: { ...parsedEvent, sequence },
        ...(coveredSequences === undefined ? {} : { coveredSequences }),
      })
    }
    if (!includeTimeline) continue
    if (record.event === undefined || record.event === null || typeof record.event !== 'object') {
      timeline.push({
        event: { type: 'unknown', name: 'history/missing-event', payload: { index } },
        sequence,
      })
      continue
    }
    if (eventRecord === undefined || typeof eventRecord.type !== 'string') {
      timeline.push({
        event: { type: 'unknown', name: 'history/invalid-event', payload: { index } },
        sequence,
      })
      continue
    }
    timeline.push({
      event: parsedEvent ?? { type: 'unknown', name: eventRecord.type, payload: { index } },
      sequence,
    })
  }
  // The Host normally emits the open snapshot in durable order, but an
  // overlapping reconnect/open can assemble this payload from more than one
  // source. Keep the ledger canonical before it becomes the pagination and
  // rebuild input; equal durable sequences retain their source order.
  const orderedHistory = history
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => left.entry.sequence - right.entry.sequence || left.index - right.index)
    .map(({ entry }) => entry)
  return { history: orderedHistory, timeline }
}

function parseSessionHistoryPage(value: unknown): {
  readonly events: readonly SessionHistoryEvent[]
  readonly hasMore: boolean
  readonly beforeSequence?: number
  readonly coveredSequenceRanges?: readonly SessionSequenceRange[]
  readonly projection?: SessionProjectionSnapshot
} {
  const page = object(value)
  if (page === undefined || !Array.isArray(page.events) || typeof page.hasMore !== 'boolean')
    throw new Error(translate('app.error.malformedHistory'))
  const events = parseSessionHistory(page.events)
  const hasBeforeSequence = Object.hasOwn(page, 'beforeSeq')
  const parsedBeforeSequence = optionalSequence(page.beforeSeq)
  if (hasBeforeSequence && parsedBeforeSequence === undefined)
    throw new Error(translate('app.error.malformedHistory'))
  const beforeSequence = parsedBeforeSequence ?? oldestHistorySequence(events)
  const coveredSequenceRanges = parseCoveredSequenceRanges(page)
  const projection = parseSessionProjection(page.projection)
  return {
    events,
    hasMore: page.hasMore,
    ...(beforeSequence === undefined ? {} : { beforeSequence }),
    ...(coveredSequenceRanges === undefined ? {} : { coveredSequenceRanges }),
    ...(projection === undefined ? {} : { projection }),
  }
}

/**
 * Raw coverage a page can vouch for. A session page reports the unfiltered
 * ranges; a child-transcript page only has the rows that reached the
 * transcript, which is the same fallback a session page without ranges uses.
 */
function historyPageCoverage(page: {
  readonly events: readonly SessionHistoryEvent[]
  readonly coveredSequenceRanges?: readonly SessionSequenceRange[]
}): readonly SessionSequenceRange[] {
  return page.coveredSequenceRanges ?? historySequenceRanges(page.events)
}

function parseCoveredSequences(record: Record<string, unknown>): readonly number[] | undefined {
  if (!Object.hasOwn(record, 'coveredSequences')) return undefined
  if (!Array.isArray(record.coveredSequences)) throw new Error(translate('app.error.malformedHistory'))
  const sequences: number[] = []
  let previous = -1
  for (const value of record.coveredSequences) {
    const sequence = optionalSequence(value)
    if (sequence === undefined || sequence <= previous)
      throw new Error(translate('app.error.malformedHistory'))
    sequences.push(sequence)
    previous = sequence
  }
  return sequences
}

function parseCoveredSequenceRanges(
  page: Record<string, unknown>,
): readonly SessionSequenceRange[] | undefined {
  if (!Object.hasOwn(page, 'coveredSeqRanges')) return undefined
  if (!Array.isArray(page.coveredSeqRanges)) throw new Error(translate('app.error.malformedHistory'))
  const ranges: SessionSequenceRange[] = []
  for (const value of page.coveredSeqRanges) {
    const range = object(value)
    const from = optionalSequence(range?.from)
    const to = optionalSequence(range?.to)
    if (from === undefined || to === undefined || to < from)
      throw new Error(translate('app.error.malformedHistory'))
    ranges.push({ from, to })
  }
  return mergeSequenceRanges([], ranges)
}

function parseSessionProjection(value: unknown): SessionProjectionSnapshot | undefined {
  if (value === undefined) return undefined
  const projection = object(value)
  if (
    projection === undefined ||
    !Number.isSafeInteger(projection.asOfSequence) ||
    (projection.asOfSequence as number) < -1 ||
    object(projection.values) === undefined
  )
    throw new Error(translate('app.error.malformedProjection'))
  return {
    asOfSequence: projection.asOfSequence as number,
    values: projection.values as Readonly<Record<string, unknown>>,
  }
}

function mergeHistory(
  current: readonly SessionHistoryEvent[],
  additions: readonly SessionHistoryEvent[],
): readonly SessionHistoryEvent[] {
  if (additions.length === 0) return current
  let previousSequence = current[current.length - 1]?.sequence
  let appendOnly = true
  for (let index = 1; index < current.length; index += 1) {
    const previous = current[index - 1]?.sequence
    const currentSequence = current[index]?.sequence
    if (previous !== undefined && currentSequence !== undefined && currentSequence < previous) {
      appendOnly = false
      break
    }
  }
  for (const addition of additions) {
    if (!appendOnly) break
    if (previousSequence !== undefined && addition.sequence <= previousSequence) {
      appendOnly = false
      break
    }
    previousSequence = addition.sequence
  }
  // Live stream frames are monotonic in the durable DSH sequence space. Keep
  // the common path linear in the new entries; older-page merges and replay
  // races still use the deduplicating sorted path below.
  if (appendOnly) return current.concat(additions)

  // A durable sequence identifies the upstream log position, not a whole
  // history batch. Projection records intentionally share one sequence, and
  // replay races can also present the same sequence with a distinct event.
  // Indexing only by sequence silently discarded those records and was the
  // source of missing state in complex multi-tool streams. Deduplicate only
  // exact logical event replays, then keep every distinct same-sequence row.
  const byIdentity = new Map<string, SessionHistoryEvent>()
  for (const entry of [...current, ...additions]) {
    const identity = historyEntryIdentity(entry)
    const existing = byIdentity.get(identity)
    if (existing === undefined) byIdentity.set(identity, entry)
    else byIdentity.set(identity, mergeHistoryCoverage(existing, entry))
  }
  const unique = [...byIdentity.values()]
  return unique
    .filter((entry) => !isDeltaCoveredByCompactedEntry(entry, unique))
    .sort((left, right) => left.sequence - right.sequence)
}

function historyEntryIdentity(entry: SessionHistoryEvent): string {
  try {
    return `${entry.sequence}:${JSON.stringify(entry.event)}`
  } catch {
    // Parsed DSH payloads are acyclic, but retain a deterministic fallback if
    // a future adapter event carries a non-serializable extension value.
    return `${entry.sequence}:${entry.event.type}`
  }
}

function mergeHistoryCoverage(left: SessionHistoryEvent, right: SessionHistoryEvent): SessionHistoryEvent {
  const coveredSequences = [
    ...new Set([...(left.coveredSequences ?? []), ...(right.coveredSequences ?? [])]),
  ].sort((first, second) => first - second)
  return coveredSequences.length === 0 ? left : { ...left, coveredSequences }
}

function oldestHistorySequence(history: readonly SessionHistoryEvent[]): number | undefined {
  return history.reduce<number | undefined>((oldest, entry) => {
    const entryOldest = Math.min(entry.sequence, ...(entry.coveredSequences ?? []))
    return oldest === undefined ? entryOldest : Math.min(oldest, entryOldest)
  }, undefined)
}

function historyCoversSequenceRange(
  history: readonly SessionHistoryEvent[],
  fromSequence: number,
  toSequence: number,
): boolean {
  return sequenceRangesCover(historySequenceRanges(history), fromSequence, toSequence)
}

function historySequenceRanges(history: readonly SessionHistoryEvent[]): readonly SessionSequenceRange[] {
  const sequences = history.flatMap((entry) => entry.coveredSequences ?? [entry.sequence])
  return mergeSequenceRanges(
    [],
    sequences.map((sequence) => ({ from: sequence, to: sequence })),
  )
}

function mergeSequenceRanges(
  current: readonly SessionSequenceRange[],
  additions: readonly SessionSequenceRange[],
): readonly SessionSequenceRange[] {
  const ordered = [...current, ...additions].sort(
    (left, right) => left.from - right.from || left.to - right.to,
  )
  const merged: SessionSequenceRange[] = []
  for (const range of ordered) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && range.from <= previous.to + 1) {
      if (range.to > previous.to) merged[merged.length - 1] = { ...previous, to: range.to }
    } else merged.push(range)
  }
  return merged
}

function sequenceRangesCover(
  ranges: readonly SessionSequenceRange[],
  fromSequence: number,
  toSequence: number,
): boolean {
  if (fromSequence > toSequence) return true
  return ranges.some((range) => range.from <= fromSequence && range.to >= toSequence)
}

function isDeltaCoveredByCompactedEntry(
  entry: SessionHistoryEvent,
  candidates: readonly SessionHistoryEvent[],
): boolean {
  if (entry.coveredSequences !== undefined || !isDeltaHistoryEvent(entry.event)) return false
  return candidates.some(
    (candidate) =>
      candidate.coveredSequences !== undefined &&
      candidate.coveredSequences.length > 1 &&
      isDeltaHistoryEvent(candidate.event) &&
      candidate.event.type === entry.event.type &&
      candidate.event.messageId === entry.event.messageId &&
      candidate.coveredSequences.includes(entry.sequence),
  )
}

function isDeltaHistoryEvent(
  event: SessionHistoryEvent['event'],
): event is Extract<SessionHistoryEvent['event'], { readonly type: 'message.delta' | 'reasoning.delta' }> {
  return event.type === 'message.delta' || event.type === 'reasoning.delta'
}

function newestHistorySequence(history: readonly SessionHistoryEvent[]): number | undefined {
  return history.reduce<number | undefined>(
    (newest, entry) => (newest === undefined ? entry.sequence : Math.max(newest, entry.sequence)),
    undefined,
  )
}

interface PendingReplayEntry {
  readonly message: HostMessage
  readonly index: number
  readonly hostSequence: number
  readonly event?: BackendEvent
  readonly durableSequence?: number
}

function isAdvisoryReplayMessage(message: HostMessage): boolean {
  const event = parseHostDomainEvent(message)
  // Cursorless assistant frames and host-only interruption completions were
  // already applied live after first paint. Replaying them over an advisory
  // snapshot would either duplicate a settled answer or regress a still-live
  // prefix. Durable records and idempotent control events still need replay.
  return !(
    event?.type === 'message.delta' ||
    event?.type === 'reasoning.delta' ||
    (event?.type === 'message.completed' && event.interrupted === true && event.sequence === undefined)
  )
}

/**
 * Order the messages collected while a session is opening without mixing the
 * two sequence spaces. Durable DSH events must be applied in DSH order because
 * the timeline reducer rejects an older durable cursor. Alpha assistant
 * deltas are cursorless, however, and are published before their matching
 * durable `message.completed`; Host sequence is the only order that contains
 * both records. Place those transient prefixes immediately before their
 * settlement while retaining DSH order for all durable records.
 */
function orderPendingReplayMessages(messages: readonly HostMessage[]): readonly HostMessage[] {
  const entries = messages.map<PendingReplayEntry>((message, index) => {
    const event = parseHostDomainEvent(message) ?? undefined
    return {
      message,
      index,
      hostSequence: message.type === 'event' ? message.sequence : Number.MAX_SAFE_INTEGER,
      ...(event === undefined ? {} : { event }),
      ...(event?.sequence === undefined ? {} : { durableSequence: event.sequence }),
    }
  })
  const durable = entries
    .filter((entry) => entry.durableSequence !== undefined)
    .sort(
      (left, right) =>
        left.durableSequence! - right.durableSequence! ||
        left.hostSequence - right.hostSequence ||
        left.index - right.index,
    )
  const nonDurable = entries.filter((entry) => entry.durableSequence === undefined)
  if (nonDurable.length === 0) return durable.map(({ message }) => message)

  const beforeDurable = new Map<number, PendingReplayEntry[]>()
  for (const entry of nonDurable) {
    const anchor = transientSettlementAnchor(entry, durable)
    const insertionIndex = durable.findIndex((candidate) => entry.hostSequence < candidate.hostSequence)
    const durableIndex = anchor ?? (insertionIndex < 0 ? durable.length : insertionIndex)
    const bucket = beforeDurable.get(durableIndex)
    if (bucket === undefined) beforeDurable.set(durableIndex, [entry])
    else bucket.push(entry)
  }

  const ordered: PendingReplayEntry[] = []
  for (let index = 0; index <= durable.length; index += 1) {
    const bucket = beforeDurable.get(index)
    if (bucket !== undefined)
      ordered.push(
        ...bucket.sort((left, right) => left.hostSequence - right.hostSequence || left.index - right.index),
      )
    const durableEntry = durable[index]
    if (durableEntry !== undefined) ordered.push(durableEntry)
  }
  return ordered.map(({ message }) => message)
}

function transientSettlementAnchor(
  entry: PendingReplayEntry,
  durable: readonly PendingReplayEntry[],
): number | undefined {
  const event = entry.event
  if (
    event === undefined ||
    (event.type !== 'message.delta' && event.type !== 'reasoning.delta') ||
    event.transientAttemptId === undefined ||
    event.transientIndex === undefined
  )
    return undefined
  const key = assistantReplayKey(event)
  const startedAfterSequence = event.transientStartedAfterSequence
  const attemptBoundary =
    startedAfterSequence === undefined
      ? undefined
      : (() => {
          const index = durable.findIndex(
            (candidate) =>
              candidate.durableSequence !== undefined && candidate.durableSequence > startedAfterSequence,
          )
          return index < 0 ? durable.length : index
        })()
  const afterTransient = durable.findIndex(
    (candidate) =>
      candidate.event?.type === 'message.completed' &&
      assistantReplayKey(candidate.event) === key &&
      (startedAfterSequence === undefined ||
        (candidate.durableSequence !== undefined && candidate.durableSequence > startedAfterSequence)) &&
      candidate.hostSequence >= entry.hostSequence,
  )
  if (afterTransient >= 0) return Math.max(attemptBoundary ?? 0, afterTransient)
  // An earlier settlement belongs to a previous retry. If the new attempt has
  // not produced its own settlement yet, keep the transient prefix at its
  // Host-sequence position; moving it before the old settlement would make
  // the old durable row absorb and replace the live node during replay.
  if (attemptBoundary !== undefined) {
    const insertionIndex = durable.findIndex((candidate) => entry.hostSequence < candidate.hostSequence)
    return Math.max(attemptBoundary, insertionIndex < 0 ? durable.length : insertionIndex)
  }
  return undefined
}

function assistantReplayKey(
  event: Extract<BackendEvent, { readonly type: 'message.delta' | 'reasoning.delta' | 'message.completed' }>,
): string {
  // Alpha's cursorless frame uses the deterministic turn/step fallback id,
  // while the durable assistant message carries DSH's generated message id.
  // Coordinates are the shared identity for a live attempt; only legacy
  // events without coordinates can fall back to their message id.
  return event.turn !== undefined && event.step !== undefined
    ? [event.sessionId, event.turn, event.step].join('\u0000')
    : [event.sessionId, event.messageId].join('\u0000')
}

function optionalSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function finiteTransientSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function finiteTransientStartSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1 ? value : undefined
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function historyTime(event: BackendEvent): string {
  const value = 'time' in event ? event.time : undefined
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : new Date().toISOString()
}

function hydrateTimelineFromHistoryEvents(
  sessionId: string,
  history: readonly SessionHistoryEvent[],
): TimelineState {
  return hydrateTimelineFromEntries(sessionId, history)
}

type ConversationTimelineNode = Extract<TimelineNode, { readonly kind: 'assistant-message' | 'reasoning' }>

function isLiveTransientNode(node: TimelineNode): node is ConversationTimelineNode {
  if (node.kind === 'assistant-message')
    return (
      node.liveAttemptId !== undefined &&
      (node.streaming || node.reasoning?.streaming === true || node.interrupted === true)
    )
  return node.kind === 'reasoning' && node.liveAttemptId !== undefined && node.streaming
}

/**
 * A durable ledger rebuild must not erase a stream that has no durable
 * sequence yet. Keep only genuinely active transient nodes; completed nodes
 * are reconstructed from history and must not be allowed to shadow it.
 */
function mergeLiveTransientNodes(
  rebuilt: TimelineState,
  previous: TimelineState,
  history: readonly SessionHistoryEvent[] = [],
): TimelineState {
  const liveNodes = previous.nodes.filter(isLiveTransientNode)
  if (liveNodes.length === 0) return rebuilt

  const nodes = [...rebuilt.nodes]
  for (const live of liveNodes) {
    // `assistant/attempt` is a durable non-visible settlement. If the
    // rebuilt history already contains the settlement for this attempt, do
    // not reattach the old process-local prefix just because the durable row
    // intentionally produces no TimelineNode.
    if (findMatchingAssistantAttempt(history, rebuilt.sessionId, live) !== undefined) continue
    const index = findMatchingTransientNode(nodes, live)
    if (index < 0) {
      const settlement = findMatchingSettledAssistant(nodes, live)
      // DSH's assistant stream carries the durable cursor immediately before
      // the attempt started. A settlement at or below that cursor belongs to
      // an earlier retry and must remain beside the still-live attempt; only a
      // later settlement retires the live prefix during a ledger rebuild.
      if (
        settlement === undefined ||
        (live.liveStartedAfterSequence !== undefined &&
          settlement.sequence !== undefined &&
          settlement.sequence <= live.liveStartedAfterSequence)
      )
        insertLiveNodeAtPreviousPosition(nodes, previous.nodes, live)
      continue
    }
    const current = nodes[index]
    if (current === undefined) {
      nodes.push(live)
      continue
    }
    nodes[index] = mergeTransientNode(current, live)
  }
  return {
    ...rebuilt,
    nodes,
    nodeChangeBase: rebuilt.nodes,
    nodeChangeStart: 0,
  }
}

/**
 * Rebuilding from the durable ledger can remove a process-local stream row
 * while retaining the durable rows that were adjacent to it. Re-append would
 * move the live answer below later tool/deliverable rows, so restore it beside
 * the nearest durable neighbour from the previous transcript instead.
 */
function insertLiveNodeAtPreviousPosition(
  nodes: TimelineNode[],
  previousNodes: readonly TimelineNode[],
  live: TimelineNode,
): void {
  const previousIndex = previousNodes.indexOf(live)
  if (previousIndex >= 0) {
    for (let index = previousIndex + 1; index < previousNodes.length; index += 1) {
      const anchor = previousNodes[index]
      if (anchor === undefined || isLiveTransientNode(anchor)) continue
      const currentIndex = findStableTimelineNodeIndex(nodes, anchor)
      if (currentIndex >= 0) {
        nodes.splice(currentIndex, 0, live)
        return
      }
    }
    for (let index = previousIndex - 1; index >= 0; index -= 1) {
      const anchor = previousNodes[index]
      if (anchor === undefined || isLiveTransientNode(anchor)) continue
      const currentIndex = findStableTimelineNodeIndex(nodes, anchor)
      if (currentIndex >= 0) {
        nodes.splice(currentIndex + 1, 0, live)
        return
      }
    }
  }

  const boundary = 'liveStartedAfterSequence' in live ? live.liveStartedAfterSequence : undefined
  if (boundary !== undefined) {
    const laterIndex = nodes.findIndex((node) => {
      const sequence = timelineNodeSequence(node)
      return sequence !== undefined && sequence > boundary
    })
    if (laterIndex >= 0) {
      nodes.splice(laterIndex, 0, live)
      return
    }
  }
  nodes.push(live)
}

function findStableTimelineNodeIndex(nodes: readonly TimelineNode[], anchor: TimelineNode): number {
  return nodes.findIndex((node) => node.kind === anchor.kind && node.id === anchor.id)
}

function timelineNodeSequence(node: TimelineNode): number | undefined {
  switch (node.kind) {
    case 'assistant-message':
    case 'tool':
    case 'deliverables':
    case 'retry':
    case 'turn-terminal':
    case 'event':
      return node.sequence
    default:
      return undefined
  }
}

function findMatchingAssistantAttempt(
  history: readonly SessionHistoryEvent[],
  sessionId: string | undefined,
  live: ConversationTimelineNode,
): SessionHistoryEvent | undefined {
  if (
    sessionId === undefined ||
    live.kind !== 'assistant-message' ||
    live.turn === undefined ||
    live.step === undefined ||
    live.liveStartedAfterSequence === undefined
  )
    return undefined
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index]
    if (
      entry?.event.type === 'assistant.attempt' &&
      entry.event.sessionId === sessionId &&
      entry.event.turn === live.turn &&
      entry.event.step === live.step &&
      entry.sequence > live.liveStartedAfterSequence
    )
      return entry
  }
  return undefined
}

function isSettledDurableAssistant(
  node: TimelineNode,
): node is Extract<TimelineNode, { readonly kind: 'assistant-message' }> {
  return (
    node.kind === 'assistant-message' &&
    node.sequence !== undefined &&
    !node.streaming &&
    node.reasoning?.streaming !== true
  )
}

function findMatchingTransientNode(nodes: readonly TimelineNode[], live: ConversationTimelineNode): number {
  const byId = findNodeIndexFromEnd(
    nodes,
    (node) =>
      (node.kind === 'assistant-message' || node.kind === 'reasoning') &&
      node.id === live.id &&
      isOpenTransientConversationNode(node),
  )
  if (byId >= 0) return byId
  if (live.kind !== 'assistant-message' || live.turn === undefined || live.step === undefined) return -1
  return findNodeIndexFromEnd(
    nodes,
    (node) =>
      node.kind === 'assistant-message' &&
      node.turn === live.turn &&
      node.step === live.step &&
      isOpenTransientConversationNode(node),
  )
}

function findMatchingSettledAssistant(
  nodes: readonly TimelineNode[],
  live: ConversationTimelineNode,
): Extract<TimelineNode, { readonly kind: 'assistant-message' }> | undefined {
  const index = findNodeIndexFromEnd(nodes, (node) => {
    if (!isSettledDurableAssistant(node)) return false
    if (node.id === live.id) return true
    return (
      live.kind === 'assistant-message' &&
      live.turn !== undefined &&
      live.step !== undefined &&
      node.turn === live.turn &&
      node.step === live.step
    )
  })
  const node = index < 0 ? undefined : nodes[index]
  return node?.kind === 'assistant-message' ? node : undefined
}

function isOpenTransientConversationNode(node: TimelineNode): boolean {
  if (node.kind === 'assistant-message')
    return node.streaming || node.reasoning?.streaming === true || node.liveAttemptId !== undefined
  return node.kind === 'reasoning' && node.streaming
}

function findNodeIndexFromEnd(
  nodes: readonly TimelineNode[],
  predicate: (node: TimelineNode) => boolean,
): number {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node !== undefined && predicate(node)) return index
  }
  return -1
}

function mergeTransientNode(current: TimelineNode, live: ConversationTimelineNode): TimelineNode {
  if (live.kind === 'assistant-message' && current.kind === 'assistant-message') {
    const merged = {
      ...current,
      markdown: live.markdown,
      streaming: live.streaming,
      ...(live.turn === undefined ? {} : { turn: live.turn }),
      ...(live.step === undefined ? {} : { step: live.step }),
      ...(live.liveAttemptId === undefined ? {} : { liveAttemptId: live.liveAttemptId }),
      ...(live.liveLastIndex === undefined ? {} : { liveLastIndex: live.liveLastIndex }),
      ...(live.liveStartedAfterSequence === undefined
        ? {}
        : { liveStartedAfterSequence: live.liveStartedAfterSequence }),
      ...(live.interrupted === undefined ? {} : { interrupted: live.interrupted }),
    }
    if (live.reasoning === undefined) delete merged.reasoning
    else merged.reasoning = live.reasoning
    return merged
  }
  if (live.kind === 'reasoning' && current.kind === 'assistant-message')
    return {
      ...current,
      reasoning: { markdown: live.markdown, streaming: live.streaming },
      ...(live.liveAttemptId === undefined ? {} : { liveAttemptId: live.liveAttemptId }),
      ...(live.liveLastIndex === undefined ? {} : { liveLastIndex: live.liveLastIndex }),
      ...(live.liveStartedAfterSequence === undefined
        ? {}
        : { liveStartedAfterSequence: live.liveStartedAfterSequence }),
    }
  return live
}

function hydrateTimelineFromEntries(
  sessionId: string,
  valid: readonly HydratedTimelineEntry[],
): TimelineState {
  let timeline: TimelineState = {
    sessionId,
    nodes: [],
    lastSequence: valid.length === 0 ? -1 : Number.MIN_SAFE_INTEGER,
    eventCount: 0,
  }
  // DSH history pages are already emitted in sequence order on the common
  // path. Avoid an eager copy plus O(n log n) sort during every session open;
  // retain the sort fallback for defensive handling of malformed or merged
  // pages that arrive out of order.
  const ordered = isNonDecreasingBySequence(valid)
    ? valid
    : [...valid].sort((left, right) => left.sequence - right.sequence)
  timeline = reduceTimelineBatch(
    timeline,
    ordered.map(({ event, sequence }) => ({
      sequence,
      event,
      // Projection/lifecycle records carry durable sequence metadata but are
      // not conversation records. Keep their state updates while preventing
      // them from consuming the timeline cursor during history rehydration.
      ...timelineSequenceOptions(event),
    })),
  )
  const lastSequence = ordered.reduce(
    (maximum, entry) =>
      timelineSequenceOptions(entry.event).advanceSequence === false
        ? maximum
        : Math.max(maximum, entry.sequence),
    -1,
  )
  return ordered.length === 0 ? timeline : { ...timeline, lastSequence }
}

function isNonDecreasingBySequence(entries: readonly HydratedTimelineEntry[]): boolean {
  let previous: number | undefined
  for (const entry of entries) {
    if (previous !== undefined && entry.sequence < previous) return false
    previous = entry.sequence
  }
  return true
}

function finiteEventSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function finiteEventIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function finiteEventTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : undefined
  }
  return undefined
}

function turnEndReason(value: unknown): TurnEndReasonKind {
  const kind = isRecord(value) ? value.kind : value
  return kind === 'completed' ||
    kind === 'aborted' ||
    kind === 'blocked' ||
    kind === 'error' ||
    kind === 'max-tokens' ||
    kind === 'interrupted'
    ? kind
    : 'unknown'
}

function turnEndFailure(value: unknown): TurnEndFailure | undefined {
  const record = object(value)
  const failure = record?.kind === 'error' ? object(record.error) : record
  if (failure === undefined) return undefined
  if (typeof failure.message !== 'string') return undefined
  const compact = failure.message.replace(/\s+/gu, ' ').trim()
  if (compact === '') return undefined
  const redacted = compact.replace(
    /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret|private[_ -]?key|token|prompt|body|response)\b\s*[:=]\s*[^\s,;]+/giu,
    (match) => match.replace(/[:=].*$/u, ': [redacted]'),
  )
  const code =
    typeof failure.code === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(failure.code)
      ? failure.code
      : undefined
  // The durable reason carries the provider adapter's own failure message, and
  // the reference client renders it whole in its turn-error row. Clipping here
  // would cut the user's only diagnosis with nothing on screen to reveal it.
  return { message: redacted, ...(code === undefined ? {} : { code }) }
}

function parseTokenUsage(value: unknown): TokenUsage | undefined {
  const record = object(value)
  if (record === undefined) return undefined
  const inputValue = Object.prototype.hasOwnProperty.call(record, 'inputTokens')
    ? record.inputTokens
    : record.uncachedInputTokens
  const inputTokens = tokenCount(inputValue)
  const outputTokens = tokenCount(record.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const cacheReadTokens = tokenCount(record.cacheReadTokens)
  const cacheWriteTokens = tokenCount(record.cacheWriteTokens)
  const reasoningTokens = tokenCount(record.reasoningTokens)
  if (
    (Object.prototype.hasOwnProperty.call(record, 'cacheReadTokens') && cacheReadTokens === undefined) ||
    (Object.prototype.hasOwnProperty.call(record, 'cacheWriteTokens') && cacheWriteTokens === undefined) ||
    (Object.prototype.hasOwnProperty.call(record, 'reasoningTokens') && reasoningTokens === undefined)
  )
    return undefined
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function promptTemplateVariables(values: readonly string[]): PromptTemplateVariable[] {
  if (values.some((value) => !isPromptTemplateVariable(value)))
    throw new Error(translate('app.error.promptTemplate'))
  return values.map((value) => value as PromptTemplateVariable)
}

type FeatureSuccessResponse = Extract<FeatureResponse, { readonly ok: true }>
type FeatureResponsePayload = FeatureSuccessResponse['payload']
type FeatureChangeSummary = Extract<FeatureResponsePayload, { readonly kind: 'changes' }>['items'][number]
type FeatureChangeDetailPayload = Extract<FeatureResponsePayload, { readonly kind: 'change.detail' }>
type FeatureTaskList = Extract<FeatureResponsePayload, { readonly kind: 'tasks' }>
type FeatureTaskSummary = Extract<FeatureResponsePayload, { readonly kind: 'tasks' }>['items'][number]
type FeatureCheckpointSummary = Extract<
  FeatureResponsePayload,
  { readonly kind: 'checkpoints' }
>['items'][number]
type FeatureCheckpointPreview = Extract<
  FeatureResponsePayload,
  { readonly kind: 'checkpoint.preview' }
>['preview']
type FeaturePromptTemplateSummary = Extract<
  FeatureResponsePayload,
  { readonly kind: 'prompt.templates' }
>['items'][number]
type FeaturePromptTemplate = Extract<FeatureResponsePayload, { readonly kind: 'prompt.template' }>['template']
type FeaturePromptTemplateInsertion = Extract<
  FeatureResponsePayload,
  { readonly kind: 'prompt.template.inserted' }
>
type FeatureOperationPayload = Extract<FeatureResponsePayload, { readonly kind: 'operation' }>

function parseFeatureTasksResult(value: unknown):
  | {
      readonly items: readonly TaskSummary[]
      readonly scope: TaskListScope
      readonly complete: boolean
      readonly omittedSessions: number
    }
  | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'store-parse',
    ok: true,
    payload: value,
  })
  if (!parsed.success || parsed.data.ok !== true || parsed.data.payload.kind !== 'tasks') return undefined
  const payload: FeatureTaskList = parsed.data.payload
  return {
    items: payload.items.map(parseFeatureTaskSummary),
    scope: payload.scope,
    complete: payload.complete,
    omittedSessions: payload.omittedSessions,
  }
}

function parseFeatureCheckpointsResult(value: unknown): readonly CheckpointSummary[] | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'store-parse',
    ok: true,
    payload: value,
  })
  if (!parsed.success || parsed.data.ok !== true || parsed.data.payload.kind !== 'checkpoints')
    return undefined
  return parsed.data.payload.items.map(parseFeatureCheckpointSummary)
}

function parseFeatureCheckpointSummary(item: FeatureCheckpointSummary): CheckpointSummary {
  return {
    checkpointId: item.checkpointId,
    sessionId: item.sessionId,
    workspaceFolderId: item.workspaceFolderId,
    createdAt: item.createdAt,
    ...(item.label === undefined ? {} : { label: item.label }),
    fileCount: item.fileCount,
    totalBytes: item.totalBytes,
    state: item.state,
    restoreAllowed: item.restoreAllowed,
    contentEnabled: item.contentEnabled,
    ...(item.expectedRevision === undefined ? {} : { expectedRevision: item.expectedRevision }),
  }
}

function parseFeatureCheckpointPreviewResult(value: unknown): CheckpointPreview | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'store-parse',
    ok: true,
    payload: value,
  })
  if (!parsed.success || parsed.data.ok !== true || parsed.data.payload.kind !== 'checkpoint.preview')
    return undefined
  const preview: FeatureCheckpointPreview = parsed.data.payload.preview
  return {
    summary: parseFeatureCheckpointSummary(preview.summary),
    files: preview.files.map((file) => ({
      relativePath: file.relativePath,
      presentAtCheckpoint: file.presentAtCheckpoint,
      ...(file.expectedCurrentHash === undefined ? {} : { expectedCurrentHash: file.expectedCurrentHash }),
      ...(file.currentHash === undefined ? {} : { currentHash: file.currentHash }),
      conflict: file.conflict,
      byteSize: file.byteSize,
    })),
    conflictCount: preview.conflictCount,
  }
}

function parseFeaturePromptTemplatesResult(value: unknown): readonly PromptTemplateSummary[] | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'store-parse',
    ok: true,
    payload: value,
  })
  if (!parsed.success || parsed.data.ok !== true || parsed.data.payload.kind !== 'prompt.templates')
    return undefined
  return parsed.data.payload.items.map(parseFeaturePromptTemplateSummary)
}

function parseFeaturePromptTemplateSummary(item: FeaturePromptTemplateSummary): PromptTemplateSummary {
  return {
    templateId: item.templateId,
    title: item.title,
    description: item.description,
    scope: item.scope,
    updatedAt: item.updatedAt,
    variables: [...item.variables],
    enabled: item.enabled,
  }
}

function parseFeaturePromptTemplateResult(value: unknown): PromptTemplate | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'store-parse',
    ok: true,
    payload: value,
  })
  if (!parsed.success || parsed.data.ok !== true || parsed.data.payload.kind !== 'prompt.template')
    return undefined
  const template: FeaturePromptTemplate = parsed.data.payload.template
  return {
    ...parseFeaturePromptTemplateSummary(template.summary),
    templateText: template.templateText,
  }
}

function parseFeaturePromptTemplateInsertionResult(value: unknown): PromptTemplateInsertion | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'store-parse',
    ok: true,
    payload: value,
  })
  if (!parsed.success || parsed.data.ok !== true || parsed.data.payload.kind !== 'prompt.template.inserted')
    return undefined
  const insertion: FeaturePromptTemplateInsertion = parsed.data.payload
  return {
    templateId: insertion.templateId,
    text: insertion.text,
    unresolvedVariables: [...insertion.unresolvedVariables],
  }
}

function parseFeatureOperationResult(value: unknown): FeatureOperationPayload | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'store-parse',
    ok: true,
    payload: value,
  })
  if (!parsed.success || parsed.data.ok !== true || parsed.data.payload.kind !== 'operation') return undefined
  return parsed.data.payload
}

function parseFeatureTaskSummary(item: FeatureTaskSummary): TaskSummary {
  return {
    taskId: item.taskId,
    sourceId: item.sourceId,
    ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
    ...(item.parentTaskId === undefined ? {} : { parentTaskId: item.parentTaskId }),
    workspaceFolderId: item.workspaceFolderId,
    kind: item.kind,
    title: item.title,
    ...(item.sessionTitle === undefined ? {} : { sessionTitle: item.sessionTitle }),
    status: item.status,
    needsUserAction: item.needsUserAction,
    ...(item.actionKind === undefined ? {} : { actionKind: item.actionKind }),
    ...(item.interactionId === undefined ? {} : { interactionId: item.interactionId }),
    ...(item.modelLabel === undefined ? {} : { modelLabel: item.modelLabel }),
    ...(item.providerLabel === undefined ? {} : { providerLabel: item.providerLabel }),
    startedAt: item.startedAt,
    updatedAt: item.updatedAt,
    ...(item.progress === undefined ? {} : { progress: item.progress }),
    childCount: item.childCount,
    canOpen: item.canOpen,
    canAnswer: item.canAnswer,
    canSessionCancel: item.canSessionCancel,
    ownerKind: item.ownerKind,
    ...(item.backendInstanceId === undefined ? {} : { backendInstanceId: item.backendInstanceId }),
    ...(item.connectionGeneration === undefined ? {} : { connectionGeneration: item.connectionGeneration }),
    taskRevision: item.taskRevision,
  }
}

function mergeTask(tasks: readonly TaskSummary[], task: TaskSummary): readonly TaskSummary[] {
  const index = tasks.findIndex((entry) => entry.taskId === task.taskId)
  if (index < 0) return [...tasks, task]
  return tasks.map((entry, entryIndex) => (entryIndex === index ? task : entry))
}

function parseFeatureChangesResult(value: unknown): readonly ChangeSetFile[] | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'store-parse',
    ok: true,
    payload: value,
  })
  if (!parsed.success || !('payload' in parsed.data) || parsed.data.ok !== true) return undefined
  const payload = parsed.data.payload
  if (payload.kind !== 'changes') return undefined
  return payload.items.map(parseFeatureChangeSummary)
}

function parseFeatureChangeDetail(value: unknown): ChangeDetail | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'store-parse',
    ok: true,
    payload: value,
  })
  if (!parsed.success || !('payload' in parsed.data) || parsed.data.ok !== true) return undefined
  const responsePayload = parsed.data.payload
  if (responsePayload.kind !== 'change.detail') return undefined
  const payload: FeatureChangeDetailPayload = responsePayload
  const summary = parseFeatureChangeSummary(payload.change)
  return {
    ...summary,
    ...(payload.redactedDiff === undefined ? {} : { redactedDiff: payload.redactedDiff }),
    diffTruncated: payload.truncated === true,
  }
}

function parseFeatureChangeSummary(item: FeatureChangeSummary): ChangeSetFile {
  return {
    changeId: item.changeId,
    sessionId: item.sessionId,
    workspaceFolderId: item.workspaceFolderId,
    relativePath: item.relativePath,
    ...(item.previousRelativePath === undefined ? {} : { previousRelativePath: item.previousRelativePath }),
    status: item.status,
    ...(item.additions === undefined ? {} : { additions: item.additions }),
    ...(item.deletions === undefined ? {} : { deletions: item.deletions }),
    locations: item.locations.map((location) => ({
      path: location.relativePath,
      ...(location.line === undefined ? {} : { line: location.line }),
    })),
    evidence: fromFeatureChangeEvidence(item.evidence),
    applicationState: fromFeatureChangeApplicationState(item.applicationState),
    reviewState: item.reviewState,
    sourceIds: [...item.sourceIds],
    sourceInteractionIds: [],
    sourceToolCallIds: [...item.sourceIds],
    firstSeenAt: item.firstSeenAt,
    lastSeenAt: item.lastSeenAt,
    identity: featureEventIdentity(item.identity),
    diffAvailable: item.diffAvailable,
  }
}

function featureEventIdentity(value: FeatureChangeSummary['identity']): FeatureEventIdentity {
  const optional = {
    ...(value.eventId === undefined ? {} : { eventId: value.eventId }),
    ...(value.rpcId === undefined ? {} : { rpcId: value.rpcId }),
    ...(value.toolCallId === undefined ? {} : { toolCallId: value.toolCallId }),
  }
  if (value.stream === 'mux')
    return {
      ...optional,
      backendInstanceId: value.backendInstanceId,
      connectionGeneration: value.connectionGeneration,
      stream: 'mux',
      sessionId: value.sessionId,
      serverSeq: value.serverSeq,
    }
  return {
    ...optional,
    backendInstanceId: value.backendInstanceId,
    connectionGeneration: value.connectionGeneration,
    stream: value.stream,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    localSeq: value.localSeq,
  }
}

function fromFeatureChangeEvidence(evidence: FeatureChangeSummary['evidence']): ChangeSetFile['evidence'] {
  switch (evidence) {
    case 'structured-proposal':
      return 'structuredProposal'
    case 'structured-tool-success':
      return 'structuredToolSuccess'
    case 'filesystem-observed':
      return 'filesystemObserved'
    case 'structured-location-only':
      return 'structuredLocationOnly'
    case 'failed':
      return 'failed'
    case 'incomplete':
      return 'incomplete'
  }
  return 'incomplete'
}

function fromFeatureChangeApplicationState(
  state: FeatureChangeSummary['applicationState'],
): ChangeSetFile['applicationState'] {
  switch (state) {
    case 'proposed':
      return 'proposed'
    case 'applied-observed':
      return 'appliedObserved'
    case 'failed':
      return 'failed'
    case 'unknown':
      return 'unknown'
  }
  return 'unknown'
}

function parseEditorContextItems(value: unknown): readonly EditorContextItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.map(parseEditorContextItem)
  return items.every((item): item is EditorContextItem => item !== undefined) ? items : undefined
}

function parseEditorContextAvailableKinds(value: unknown): readonly EditorContextKind[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const kinds = value.map((entry: unknown): EditorContextKind | undefined => {
    if (entry === 'open-document') return 'file'
    if (entry === 'selection' || entry === 'diagnostic' || entry === 'symbol') return entry
    return undefined
  })
  return kinds.every((kind): kind is EditorContextKind => kind !== undefined)
    ? [...new Set(kinds)]
    : undefined
}

function parseEditorContextItem(value: unknown): EditorContextItem | undefined {
  const item = object(value)
  const scope = object(item?.scope)
  if (
    item === undefined ||
    scope === undefined ||
    typeof item.contextRef !== 'string' ||
    typeof item.kind !== 'string' ||
    typeof item.label !== 'string' ||
    typeof item.workspaceFolderId !== 'string' ||
    typeof item.relativePath !== 'string' ||
    !isCanonicalWorkspaceRelativePath(item.relativePath) ||
    !['selection', 'open-document', 'diagnostic', 'symbol'].includes(item.kind) ||
    typeof item.sizeBytes !== 'number' ||
    !Number.isSafeInteger(item.sizeBytes) ||
    item.sizeBytes < 0 ||
    typeof item.stale !== 'boolean' ||
    typeof item.previewAvailable !== 'boolean' ||
    typeof item.expiresAt !== 'number' ||
    !Number.isSafeInteger(item.expiresAt) ||
    typeof scope.ownerId !== 'string' ||
    typeof scope.workspaceFolderId !== 'string' ||
    scope.workspaceFolderId !== item.workspaceFolderId ||
    typeof scope.ownerViewId !== 'string' ||
    typeof scope.expiresAt !== 'number' ||
    scope.expiresAt !== item.expiresAt
  )
    return undefined
  const range = parseEditorContextRange(item.range)
  if (item.range !== undefined && range === undefined) return undefined
  const kind = item.kind === 'open-document' ? 'file' : item.kind
  if (kind !== 'selection' && kind !== 'file' && kind !== 'diagnostic' && kind !== 'symbol') return undefined
  const sessionId = optionalString(scope.sessionId)
  const backendInstanceId = optionalString(scope.backendInstanceId)
  const connectionGeneration = optionalGeneration(scope.connectionGeneration)
  const documentVersion = optionalGeneration(item.documentVersion)
  return {
    ref: {
      contextRef: item.contextRef,
      kind,
      workspaceFolderId: item.workspaceFolderId,
      ownerId: scope.ownerId,
      ownerViewId: scope.ownerViewId,
      contextStoreGeneration: 1,
      relativePath: item.relativePath,
      ...(range === undefined ? {} : { range }),
      sizeBytes: item.sizeBytes,
      capturedAt: item.expiresAt,
      ...(documentVersion === undefined ? {} : { documentVersion }),
      contentHash: '',
      expiresAt: item.expiresAt,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(backendInstanceId === undefined ? {} : { backendInstanceId }),
      ...(connectionGeneration === undefined ? {} : { connectionGeneration }),
    },
    label: item.label,
    stale: item.stale,
    previewAvailable: item.previewAvailable,
  }
}

function parseEditorContextRange(value: unknown): EditorContextItem['ref']['range'] {
  if (value === undefined) return undefined
  const range = object(value)
  const start = object(range?.start)
  const end = object(range?.end)
  if (
    start === undefined ||
    end === undefined ||
    typeof start.line !== 'number' ||
    typeof start.column !== 'number' ||
    typeof end.line !== 'number' ||
    typeof end.column !== 'number'
  )
    return undefined
  const parsed = {
    start: { line: start.line, column: start.column },
    end: { line: end.line, column: end.column },
  }
  return isValidEditorContextRange(parsed) ? parsed : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function optionalGeneration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function mergeEditorContext(
  current: readonly EditorContextItem[],
  next: readonly EditorContextItem[],
): readonly EditorContextItem[] {
  const byRef = new Map(current.map((item) => [item.ref.contextRef, item]))
  for (const item of next) byRef.set(item.ref.contextRef, item)
  return [...byRef.values()].sort((left, right) => right.ref.capturedAt - left.ref.capturedAt)
}

function attachmentFromResult(resultValue: unknown): PromptAttachment | undefined {
  const result = object(resultValue)
  const attachment = object(result?.attachment)
  if (
    result?.cancelled === true ||
    attachment === undefined ||
    typeof attachment.uri !== 'string' ||
    typeof attachment.name !== 'string'
  )
    return undefined
  return {
    uri: attachment.uri,
    name: attachment.name,
    ...(typeof attachment.mimeType === 'string' ? { mimeType: attachment.mimeType } : {}),
  }
}

function imageDataUri(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const uri = value.trim()
  return /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/u.test(uri) ? uri : undefined
}

function messageAttachments(value: unknown): readonly MessageAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (value.length > 32) return undefined
  const attachments: MessageAttachment[] = []
  for (const entry of value) {
    const record = object(entry)
    if (
      record === undefined ||
      typeof record.name !== 'string' ||
      record.name.trim() === '' ||
      (Object.prototype.hasOwnProperty.call(record, 'mimeType') && typeof record.mimeType !== 'string')
    )
      return undefined
    attachments.push({
      name: record.name,
      ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
    })
  }
  return attachments
}

function messageSessionReferenceLabels(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined
  const labels: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '' || entry.length > 512) return undefined
    if (!labels.includes(entry)) labels.push(entry)
  }
  return labels
}

function messageImages(value: unknown): readonly MessageImageReference[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (value.length > 32) return undefined
  const images: MessageImageReference[] = []
  for (const entry of value) {
    const record = object(entry)
    const attachmentId = typeof record?.attachmentId === 'string' ? record.attachmentId.trim() : ''
    const mediaType = record?.mediaType
    const bytes = positiveSafeInteger(record?.bytes)
    const width = positiveSafeInteger(record?.width)
    const height = positiveSafeInteger(record?.height)
    if (
      attachmentId === '' ||
      (mediaType !== 'image/png' &&
        mediaType !== 'image/jpeg' &&
        mediaType !== 'image/webp' &&
        mediaType !== 'image/gif') ||
      bytes === undefined ||
      width === undefined ||
      height === undefined ||
      (Object.prototype.hasOwnProperty.call(record ?? {}, 'name') &&
        record?.name !== undefined &&
        (typeof record.name !== 'string' || record.name.trim() === ''))
    )
      return undefined
    images.push({
      attachmentId,
      mediaType,
      bytes,
      width,
      height,
      ...(typeof record?.name === 'string' ? { name: record.name } : {}),
    })
  }
  const unique: MessageImageReference[] = []
  const seen = new Set<string>()
  for (const image of images) {
    if (seen.has(image.attachmentId)) continue
    seen.add(image.attachmentId)
    unique.push(image)
  }
  return unique
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function openFileCandidatesFromResult(resultValue: unknown): readonly OpenFileCandidate[] {
  const result = object(resultValue)
  if (!Array.isArray(result?.items)) return []
  return result.items.flatMap((value): OpenFileCandidate[] => {
    const item = object(value)
    if (
      item === undefined ||
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.active !== 'boolean' ||
      typeof item.supported !== 'boolean'
    )
      return []
    return [
      {
        id: item.id,
        name: item.name,
        ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}),
        active: item.active,
        supported: item.supported,
      },
    ]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return object(value) !== undefined
}

/** Keep the Webview boundary closed over the adapter-owned structured card. */
function parseToolPresentation(value: unknown): ToolPresentationView | undefined {
  const view = object(value)
  if (view === undefined || (view.phase !== 'call' && view.phase !== 'result')) return undefined
  const phase = view.phase
  if (view.card === 'generic') {
    const title = presentationText(view.title)
    const kind = presentationText(view.kind)
    const content = presentationTextList(view.content)
    if (phase === 'call') {
      const rawInput = presentationText(view.rawInput)
      const locations = parseToolLocations(view.locations)
      return {
        phase,
        card: 'generic',
        ...(title === undefined ? {} : { title }),
        ...(kind === undefined ? {} : { kind }),
        ...(rawInput === undefined ? {} : { rawInput }),
        ...(content === undefined ? {} : { content }),
        ...(locations === undefined ? {} : { locations }),
      }
    }
    return {
      phase,
      card: 'generic',
      ...(title === undefined ? {} : { title }),
      ...(kind === undefined ? {} : { kind }),
      ...(content === undefined ? {} : { content }),
    }
  }
  if (view.card === 'terminal') {
    const title = presentationText(view.title)
    if (phase === 'call') {
      if (title === undefined) return undefined
      const description = presentationText(view.description)
      const cwd = presentationWorkingDirectory(view.cwd)
      return {
        phase,
        card: 'terminal',
        title,
        ...(description === undefined ? {} : { description }),
        ...(cwd === undefined ? {} : { cwd }),
      }
    }
    const output = presentationText(view.output)
    const exitCode = presentationExitCode(view.exitCode)
    const signal = presentationText(view.signal)
    if (title === undefined && output === undefined && exitCode === undefined && signal === undefined)
      return undefined
    return {
      phase,
      card: 'terminal',
      ...(title === undefined ? {} : { title }),
      ...(output === undefined ? {} : { output }),
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(signal === undefined ? {} : { signal }),
    }
  }
  if (view.card === 'diff') {
    const title = presentationText(view.title)
    const diffs = parseToolDiffs(view.diffs)
    if (diffs.length === 0 || (phase === 'call' && title === undefined)) return undefined
    if (phase === 'call') {
      if (title === undefined) return undefined
      const locations = parseToolLocations(view.locations)
      return {
        phase,
        card: 'diff',
        title,
        diffs,
        ...(locations === undefined ? {} : { locations }),
      }
    }
    return {
      phase,
      card: 'diff',
      ...(title === undefined ? {} : { title }),
      diffs,
    }
  }
  if (phase !== 'result') return undefined
  if (view.card === 'search') return parseSearchPresentation(view)
  if (view.card === 'read') return parseReadPresentation(view)
  if (view.card === 'web') return parseWebPresentation(view)
  return undefined
}

function parseToolLocations(
  value: unknown,
): readonly { readonly path: string; readonly line?: number }[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const locations: { path: string; line?: number }[] = []
  for (const entry of value.slice(0, 32)) {
    const record = object(entry)
    const path = presentationPath(record?.path)
    if (path === undefined || seen.has(path)) continue
    seen.add(path)
    const line = nonNegativePresentationNumber(record?.line)
    locations.push({ path, ...(line === undefined ? {} : { line }) })
  }
  return locations.length === 0 ? undefined : locations
}

function parseToolDiffs(value: unknown): readonly ToolPresentationDiff[] {
  if (!Array.isArray(value)) return []
  // The pinned `write`/`edit` result carries one diff per applied hunk and the
  // host caps neither the hunk count nor the group count; a scattered
  // `replace_all` legitimately exceeds any small client-side clamp.
  return value.flatMap((entry): ToolPresentationDiff[] => {
    const diff = object(entry)
    const path = presentationPath(diff?.path)
    // Diff text is file content: a removal-only hunk has an empty `newText`,
    // and the "deleted" review state is derived from that empty text.
    const newText = presentationText(diff?.newText, true)
    const oldText = diff?.oldText === null ? null : presentationText(diff?.oldText, true)
    return path === undefined || newText === undefined || (diff?.oldText !== null && oldText === undefined)
      ? []
      : [{ path, oldText: oldText === undefined ? null : oldText, newText }]
  })
}

function parseSearchPresentation(value: Record<string, unknown>): ToolPresentationView | undefined {
  if (typeof value.truncated !== 'boolean') return undefined
  const total = nonNegativePresentationNumber(value.total)
  if (total === undefined) return undefined
  const title = presentationText(value.title)
  if (value.shape === 'paths') {
    if (!Array.isArray(value.paths)) return undefined
    const paths = value.paths.slice(0, 256).flatMap((entry) => {
      const path = presentationPath(entry)
      return path === undefined ? [] : [path]
    })
    return {
      phase: 'result',
      card: 'search',
      shape: 'paths',
      ...(title === undefined ? {} : { title }),
      paths,
      truncated: value.truncated,
      total,
    }
  }
  if (value.shape !== 'matches' || !Array.isArray(value.files)) return undefined
  // The host groups every retained match by file (`GREP_MAX_MATCHES = 250`
  // in the pinned upstream grep tool, with the meta byte cap dropping
  // trailing groups and reporting `truncated`). Clipping here would hide the
  // matches the host did keep while the card still reports the host's total.
  const files = value.files.flatMap((entry): ToolPresentationSearchFile[] => {
    const file = object(entry)
    const path = presentationWorkspacePath(file?.path)
    if (file === undefined || path === undefined || !Array.isArray(file.matches)) return []
    const matches = file.matches.flatMap((matchValue): ToolPresentationSearchMatch[] => {
      const match = object(matchValue)
      const lineNumber = positivePresentationNumber(match?.lineNumber)
      const line = presentationText(match?.line, true)
      return lineNumber === undefined || line === undefined ? [] : [{ lineNumber, line }]
    })
    return [{ path, matches }]
  })
  return {
    phase: 'result',
    card: 'search',
    shape: 'matches',
    ...(title === undefined ? {} : { title }),
    files,
    truncated: value.truncated,
    total,
  }
}

function parseReadPresentation(value: Record<string, unknown>): ToolPresentationView | undefined {
  const path = presentationPath(value.path)
  const offset = nonNegativePresentationNumber(value.offset)
  const totalLines = nonNegativePresentationNumber(value.totalLines)
  if (path === undefined || offset === undefined || totalLines === undefined || !Array.isArray(value.lines))
    return undefined
  // One pinned `read` call returns at most `READ_LIMIT = 2000` lines and the
  // adapter forwards the whole window; clipping it here would silently drop
  // file content the window total still accounts for.
  const lines = value.lines.flatMap((entry): ToolPresentationLine[] => {
    const line = object(entry)
    const number = positivePresentationNumber(line?.number)
    const text = presentationText(line?.text, true)
    return number === undefined || text === undefined ? [] : [{ number, text }]
  })
  const title = presentationText(value.title)
  const lang = presentationText(value.lang)
  const content = presentationTextList(value.content)
  return {
    phase: 'result',
    card: 'read',
    ...(title === undefined ? {} : { title }),
    path,
    offset,
    lines,
    totalLines,
    ...(lang === undefined ? {} : { lang }),
    ...(content === undefined ? {} : { content }),
  }
}

function parseWebPresentation(value: Record<string, unknown>): ToolPresentationView | undefined {
  if (typeof value.truncated !== 'boolean') return undefined
  const title = presentationText(value.title)
  if (value.kind === 'fetch') {
    const url = presentationUrl(value.url)
    const statusCode = presentationStatusCode(value.statusCode)
    if (url === undefined || statusCode === undefined) return undefined
    return {
      phase: 'result',
      card: 'web',
      kind: 'fetch',
      ...(title === undefined ? {} : { title }),
      url,
      statusCode,
      truncated: value.truncated,
    }
  }
  if (value.kind !== 'search' || !Array.isArray(value.sources)) return undefined
  const sources = value.sources.slice(0, 64).flatMap((entry): ToolPresentationSource[] => {
    const source = object(entry)
    const url = presentationUrl(source?.url)
    if (source === undefined || url === undefined) return []
    const sourceTitle = presentationText(source.title)
    const snippet = presentationText(source.snippet)
    const publishedAt = presentationText(source.publishedAt)
    return [
      {
        url,
        ...(sourceTitle === undefined ? {} : { title: sourceTitle }),
        ...(snippet === undefined ? {} : { snippet }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
      },
    ]
  })
  const answer = presentationText(value.answer)
  return {
    phase: 'result',
    card: 'web',
    kind: 'search',
    ...(title === undefined ? {} : { title }),
    sources,
    ...(answer === undefined ? {} : { answer }),
    truncated: value.truncated,
  }
}

/**
 * The host bounds no presentation string: `write` presents the whole written
 * file as a diff's `newText` and `bash` presents its executor's collected
 * output (default `maxOutputBytes` 64_000 per stream). Every card that shows
 * one of these bodies folds it for display and copies it whole, so clipping
 * here would truncate the copy with no fold or notice to reveal it.
 */
function presentationText(value: unknown, allowEmpty = false): string | undefined {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) return undefined
  return value
}

function presentationTextList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.slice(0, 32).flatMap((entry) => {
    const text = presentationText(entry)
    return text === undefined ? [] : [text]
  })
  return items.length === 0 ? undefined : items
}

function presentationPath(value: unknown): string | undefined {
  const path = presentationText(value)
  return path === undefined || hasPresentationControlCharacter(path) ? undefined : path
}

function presentationWorkspacePath(value: unknown): string | undefined {
  const path = presentationPath(value)
  return path !== undefined && isCanonicalWorkspaceRelativePath(path) ? path : undefined
}

function parsePresentedFiles(value: unknown): readonly PresentedFileView[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) return undefined
  const files: PresentedFileView[] = []
  for (const entry of value) {
    const file = object(entry)
    const path = presentationPath(file?.path)
    const hasDescription = file !== undefined && Object.hasOwn(file, 'description')
    const description = hasDescription ? presentationDisplayText(file?.description) : undefined
    if (path === undefined || (hasDescription && typeof file?.description !== 'string')) return undefined
    files.push({ path, ...(description === undefined ? {} : { description }) })
  }
  return files
}

function presentationIdentifier(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > 512 ||
    hasPresentationControlCharacter(value)
  )
    return undefined
  return value
}

function parseSubagentCatalogEntryFact(value: unknown): SubagentCatalogEntryFact | undefined {
  const entry = object(value)
  const id = presentationIdentifier(entry?.id)
  const createdAt = nonNegativePresentationNumber(entry?.createdAt)
  const hasLabel = entry !== undefined && Object.hasOwn(entry, 'label')
  const label = hasLabel ? presentationDisplayText(entry?.label) : undefined
  if (
    id === undefined ||
    createdAt === undefined ||
    (entry?.mode !== 'one-shot' && entry?.mode !== 'continuable') ||
    (hasLabel && typeof entry?.label !== 'string')
  )
    return undefined
  return {
    id,
    createdAt,
    mode: entry.mode,
    ...(label === undefined ? {} : { label }),
  }
}

function presentationWorkingDirectory(value: unknown): string | undefined {
  const directory = presentationPath(value)
  return directory === undefined || isAbsolutePresentationPath(directory) ? undefined : directory
}

function presentationUrl(value: unknown): string | undefined {
  const url = presentationText(value)
  return url === undefined || hasPresentationControlCharacter(url) ? undefined : url
}

function hasPresentationControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
  })
}

/**
 * Display-only text such as a delivered file's description or a child label.
 *
 * DSH types both as plain strings and they render on a single line, so a
 * control character is normalized rather than refused: refusing it would drop
 * the whole durable record, deleting the deliverable card or the child entry.
 */
function presentationDisplayText(value: unknown): string | undefined {
  const text = presentationText(value, true)
  if (text === undefined) return undefined
  let line = ''
  let pendingSpace = false
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      pendingSpace = line !== ''
      continue
    }
    if (pendingSpace) {
      line += ' '
      pendingSpace = false
    }
    line += character
  }
  const trimmed = line.trim()
  return trimmed === '' ? undefined : trimmed
}

function isAbsolutePresentationPath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(value)
}

function nonNegativePresentationNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function positivePresentationNumber(value: unknown): number | undefined {
  const number = nonNegativePresentationNumber(value)
  return number === undefined || number === 0 ? undefined : number
}

function presentationExitCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function presentationStatusCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined
}

function parseTeamActivity(value: unknown): TeamActivityView | undefined {
  const activity = object(value)
  if (activity === undefined || typeof activity.id !== 'string' || typeof activity.teamId !== 'string')
    return undefined
  if (
    activity.kind === 'member' &&
    typeof activity.memberId === 'string' &&
    typeof activity.name === 'string' &&
    (activity.phase === 'provisioning' || activity.phase === 'active' || activity.phase === 'failed')
  )
    return {
      kind: 'member',
      id: activity.id,
      teamId: activity.teamId,
      memberId: activity.memberId,
      name: activity.name,
      phase: activity.phase,
      ...(typeof activity.error === 'string' ? { error: activity.error } : {}),
    }
  if (
    activity.kind === 'task' &&
    typeof activity.taskId === 'string' &&
    typeof activity.subject === 'string' &&
    (activity.status === 'pending' ||
      activity.status === 'in_progress' ||
      activity.status === 'completed' ||
      activity.status === 'deleted') &&
    typeof activity.blockedByCount === 'number' &&
    Number.isSafeInteger(activity.blockedByCount) &&
    activity.blockedByCount >= 0 &&
    typeof activity.writeScopeCount === 'number' &&
    Number.isSafeInteger(activity.writeScopeCount) &&
    activity.writeScopeCount >= 0
  )
    return {
      kind: 'task',
      id: activity.id,
      teamId: activity.teamId,
      taskId: activity.taskId,
      subject: activity.subject,
      status: activity.status,
      ...(typeof activity.ownerId === 'string' ? { ownerId: activity.ownerId } : {}),
      blockedByCount: activity.blockedByCount,
      writeScopeCount: activity.writeScopeCount,
    }
  if (
    (activity.kind === 'message.queued' || activity.kind === 'message.delivered') &&
    typeof activity.messageId === 'string' &&
    typeof activity.targetId === 'string'
  )
    return {
      kind: activity.kind,
      id: activity.id,
      teamId: activity.teamId,
      messageId: activity.messageId,
      ...(typeof activity.senderName === 'string' ? { senderName: activity.senderName } : {}),
      targetId: activity.targetId,
      ...(activity.delivery === 'quiet' || activity.delivery === 'wakeup'
        ? { delivery: activity.delivery }
        : {}),
      ...(typeof activity.content === 'string' ? { content: activity.content } : {}),
    }
  return undefined
}

function isToolStatus(value: unknown): value is 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' {
  return (
    value === 'queued' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  )
}

function isSessionStatus(value: unknown): value is SessionSummary['status'] {
  return (
    value === 'idle' ||
    value === 'running' ||
    value === 'awaiting-input' ||
    value === 'failed' ||
    value === 'completed'
  )
}

function isGoalStatus(value: unknown): value is 'pending' | 'in-progress' | 'completed' | 'blocked' {
  return value === 'pending' || value === 'in-progress' || value === 'completed' || value === 'blocked'
}

function isJobStatus(value: unknown): value is 'running' | 'stopping' | 'completed' | 'failed' | 'killed' {
  return (
    value === 'running' ||
    value === 'stopping' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'killed'
  )
}

function isPermissionKind(value: unknown): value is 'allow-once' | 'deny' {
  return value === 'allow-once' || value === 'deny'
}

function parsePermissionRequest(value: Record<string, unknown>): PermissionRequest | undefined {
  const options = parsePermissionOptions(value.options)
  if (
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.sessionId) ||
    typeof value.title !== 'string' ||
    typeof value.description !== 'string' ||
    !isPermissionRisk(value.risk) ||
    options === undefined ||
    (value.rpcId !== undefined && typeof value.rpcId !== 'string') ||
    (value.callId !== undefined && !nonEmptyString(value.callId)) ||
    (value.commandLine !== undefined && typeof value.commandLine !== 'string')
  )
    return undefined
  return {
    id: value.id,
    ...(value.rpcId === undefined ? {} : { rpcId: value.rpcId }),
    sessionId: value.sessionId,
    title: value.title,
    description: value.description,
    ...(value.callId === undefined ? {} : { callId: value.callId }),
    ...(value.commandLine === undefined ? {} : { commandLine: value.commandLine }),
    risk: value.risk,
    options,
  }
}

function parsePermissionOptions(value: unknown): readonly PermissionOption[] | undefined {
  if (!Array.isArray(value)) return undefined
  const options: PermissionOption[] = []
  for (const entry of value) {
    const option = object(entry)
    if (
      option === undefined ||
      typeof option.id !== 'string' ||
      typeof option.label !== 'string' ||
      !isPermissionKind(option.kind)
    )
      return undefined
    options.push({ id: option.id, label: option.label, kind: option.kind })
  }
  return options
}

function parseUserQuestion(value: Record<string, unknown>): UserQuestion | undefined {
  const choices = value.choices === undefined ? undefined : questionChoices(value.choices)
  const intent = questionIntent(value.intent)
  const items = value.items === undefined ? undefined : questionItems(value.items)
  if (
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.sessionId) ||
    typeof value.prompt !== 'string' ||
    typeof value.allowFreeText !== 'boolean' ||
    (value.rpcId !== undefined && typeof value.rpcId !== 'string') ||
    (value.detail !== undefined && typeof value.detail !== 'string') ||
    (value.header !== undefined && typeof value.header !== 'string') ||
    (value.choices !== undefined && choices === undefined) ||
    (value.multiSelect !== undefined && typeof value.multiSelect !== 'boolean') ||
    (value.intent !== undefined && intent === undefined) ||
    (value.items !== undefined && items === undefined)
  )
    return undefined
  return {
    id: value.id,
    ...(value.rpcId === undefined ? {} : { rpcId: value.rpcId }),
    sessionId: value.sessionId,
    prompt: value.prompt,
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    ...(value.header === undefined ? {} : { header: value.header }),
    ...(choices === undefined ? {} : { choices }),
    ...(value.multiSelect === undefined ? {} : { multiSelect: value.multiSelect }),
    allowFreeText: value.allowFreeText,
    ...(intent === undefined ? {} : { intent }),
    ...(items === undefined ? {} : { items }),
  }
}

function questionChoices(value: unknown): readonly QuestionChoice[] | undefined {
  if (!Array.isArray(value)) return undefined
  const choices: QuestionChoice[] = []
  for (const entry of value) {
    const choice = object(entry)
    if (
      choice === undefined ||
      typeof choice.id !== 'string' ||
      typeof choice.label !== 'string' ||
      (choice.description !== undefined && typeof choice.description !== 'string')
    )
      return undefined
    choices.push({
      id: choice.id,
      label: choice.label,
      ...(choice.description === undefined ? {} : { description: choice.description }),
    })
  }
  return choices
}

function questionItems(value: unknown): readonly UserQuestionItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (value.length === 0) return undefined
  const items: UserQuestionItem[] = []
  for (const entry of value) {
    const item = questionItem(entry)
    if (item === undefined) return undefined
    items.push(item)
  }
  return items
}

function questionItem(value: unknown): UserQuestionItem | undefined {
  const item = object(value)
  if (item === undefined) return undefined
  const choices = item.choices === undefined ? undefined : questionChoices(item.choices)
  const intent = questionIntent(item.intent)
  if (
    typeof item.id !== 'string' ||
    typeof item.prompt !== 'string' ||
    typeof item.allowFreeText !== 'boolean' ||
    (item.detail !== undefined && typeof item.detail !== 'string') ||
    (item.header !== undefined && typeof item.header !== 'string') ||
    (item.choices !== undefined && choices === undefined) ||
    (item.multiSelect !== undefined && typeof item.multiSelect !== 'boolean') ||
    (item.intent !== undefined && intent === undefined)
  )
    return undefined
  return {
    id: item.id,
    prompt: item.prompt,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    ...(item.header === undefined ? {} : { header: item.header }),
    ...(choices === undefined ? {} : { choices }),
    ...(item.multiSelect === undefined ? {} : { multiSelect: item.multiSelect }),
    allowFreeText: item.allowFreeText,
    ...(intent === undefined ? {} : { intent }),
  }
}

function questionIntent(value: unknown): QuestionIntent | undefined {
  if (value === undefined) return undefined
  const intent = object(value)
  if (intent === undefined || intent.kind !== 'plan-review' || typeof intent.approve !== 'string')
    return undefined
  return { kind: 'plan-review', approve: intent.approve }
}

function isPermissionRisk(value: unknown): value is PermissionRequest['risk'] {
  return value === 'unknown' || value === 'low' || value === 'medium' || value === 'high'
}

function isQuestionAnswerList(
  value: readonly string[] | readonly QuestionAnswer[],
): value is readonly QuestionAnswer[] {
  return value.some((entry) => typeof entry !== 'string')
}

/** Shapes a question answer payload for the host schema: single selection,
 * label array, or the upstream batch `answers` objects with `custom` text. */
function questionResponsePayload(
  response: string | readonly string[] | readonly QuestionAnswer[],
):
  | string
  | string[]
  | { readonly id: string; readonly response: string | string[]; readonly custom?: string }[] {
  if (typeof response === 'string') return response
  if (isQuestionAnswerList(response))
    return response.map((entry) => ({
      id: entry.id,
      response: typeof entry.response === 'string' ? entry.response : [...entry.response],
      ...(entry.custom === undefined ? {} : { custom: entry.custom }),
    }))
  return [...response]
}

function isSessionSummary(value: unknown): value is SessionSummary {
  const item = object(value)
  let projectionValid = true
  if (item?.projection !== undefined) {
    try {
      projectionValid = parseSessionProjection(item.projection) !== undefined
    } catch {
      projectionValid = false
    }
  }
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    item.id.trim() !== '' &&
    typeof item.workspaceId === 'string' &&
    typeof item.title === 'string' &&
    typeof item.blank === 'boolean' &&
    isSessionStatus(item.status) &&
    typeof item.createdAt === 'string' &&
    typeof item.updatedAt === 'string' &&
    (item.cwd === undefined || typeof item.cwd === 'string') &&
    (item.workspaceFolderId === undefined ||
      (typeof item.workspaceFolderId === 'string' && item.workspaceFolderId.trim() !== '')) &&
    (item.parentSessionId === undefined ||
      (typeof item.parentSessionId === 'string' && item.parentSessionId.trim() !== '')) &&
    (item.origin === undefined || item.origin === 'subagent') &&
    (item.agentAvailable === undefined || typeof item.agentAvailable === 'boolean') &&
    (item.modelLabel === undefined || typeof item.modelLabel === 'string') &&
    (item.agentPreset === undefined || typeof item.agentPreset === 'string') &&
    projectionValid
  )
}

/**
 * The Extension Host owns the session-open response, but the Webview still
 * treats it as an untrusted protocol boundary. Optional fields are allowed to
 * remain absent for older hosts; once present, critical fields must not be
 * silently converted into empty/default state.
 */
function isSessionOpenDetail(value: unknown, sessionId: string): value is Record<string, unknown> {
  const detail = object(value)
  if (detail === undefined || detail.id !== sessionId) return false
  try {
    if (!isSessionSummary(detail)) return false
  } catch {
    return false
  }
  const permissionPresets = detail.permissionPresets
  return (
    (detail.configuration === undefined || isAgentConfiguration(detail.configuration)) &&
    (detail.history === undefined || Array.isArray(detail.history)) &&
    (detail.historyHasMore === undefined || typeof detail.historyHasMore === 'boolean') &&
    (detail.historyBeforeSequence === undefined ||
      optionalSequence(detail.historyBeforeSequence) !== undefined) &&
    (permissionPresets === undefined ||
      (Array.isArray(permissionPresets) &&
        permissionPresets.every((entry) => typeof entry === 'string' && entry.trim() !== '')))
  )
}

function isWorkspaceSummary(value: unknown): value is WorkspaceSummary {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    item.id.trim() !== '' &&
    typeof item.name === 'string' &&
    typeof item.createdAt === 'string' &&
    typeof item.updatedAt === 'string' &&
    Number.isSafeInteger(item.sessionCount) &&
    (item.sessionCount as number) >= 0 &&
    (item.path === undefined || typeof item.path === 'string') &&
    (item.sessionIds === undefined ||
      (Array.isArray(item.sessionIds) &&
        item.sessionIds.every((sessionId) => typeof sessionId === 'string' && sessionId.trim() !== '')))
  )
}

function isModelProvider(value: unknown): value is ModelProvider {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.kind === 'string' &&
    typeof item.configurable === 'boolean' &&
    (item.active === undefined || typeof item.active === 'boolean') &&
    (item.declared === undefined || typeof item.declared === 'boolean') &&
    (item.settingsNs === undefined || typeof item.settingsNs === 'string') &&
    (item.settingsPath === undefined ||
      (Array.isArray(item.settingsPath) && item.settingsPath.every((part) => typeof part === 'string'))) &&
    Array.isArray(item.fields) &&
    item.fields.every(isProviderField)
  )
}

function isProviderField(value: unknown): boolean {
  const field = object(value)
  return (
    field !== undefined &&
    typeof field.key === 'string' &&
    typeof field.label === 'string' &&
    typeof field.secret === 'boolean' &&
    typeof field.required === 'boolean' &&
    (field.enumValues === undefined ||
      (Array.isArray(field.enumValues) && field.enumValues.every((entry) => typeof entry === 'string'))) &&
    (field.writable === undefined || typeof field.writable === 'boolean') &&
    (field.value === undefined || typeof field.value === 'string')
  )
}

function isModelDescriptor(value: unknown): value is ModelDescriptor {
  const item = object(value)
  if (
    item === undefined ||
    typeof item.id !== 'string' ||
    typeof item.providerId !== 'string' ||
    typeof item.label !== 'string' ||
    typeof item.supportsReasoning !== 'boolean' ||
    (item.defaultReasoningLevel !== undefined && !nonBlankString(item.defaultReasoningLevel))
  )
    return false
  if (item.reasoningLevels === undefined) return true
  // A level the picker cannot name is one it must not offer: the label is what
  // the user reads and the id is what travels back, and neither may be blank.
  return (
    Array.isArray(item.reasoningLevels) &&
    item.reasoningLevels.every((level) => {
      const entry = object(level)
      return entry !== undefined && nonBlankString(entry.id) && nonBlankString(entry.label)
    })
  )
}

function nonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isModelCatalogFailure(value: unknown): value is ModelCatalogFailure {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.providerId === 'string' &&
    item.providerId.trim() !== '' &&
    typeof item.providerName === 'string' &&
    item.providerName.trim() !== '' &&
    typeof item.message === 'string'
  )
}

/**
 * A route the host named. It is not the same statement as the session's
 * configuration, where empty ids mean "no choice recorded": every id here is
 * required, because a directory that names half a route has not named one.
 */
function isModelSelection(value: unknown): value is ModelSelection {
  const item = object(value)
  return (
    item !== undefined &&
    nonBlankString(item.providerId) &&
    nonBlankString(item.modelId) &&
    (item.reasoningLevel === undefined || nonBlankString(item.reasoningLevel))
  )
}

function sameModelSelection(left: ModelSelection | undefined, right: ModelSelection): boolean {
  return (
    left !== undefined &&
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.reasoningLevel === right.reasoningLevel
  )
}

function isDiscoveredModel(value: unknown): value is DiscoveredModel {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    item.id.trim() !== '' &&
    item.id.length <= 256 &&
    typeof item.label === 'string' &&
    item.label.trim() !== '' &&
    item.label.length <= 512 &&
    (item.contextWindow === undefined ||
      (typeof item.contextWindow === 'number' &&
        Number.isSafeInteger(item.contextWindow) &&
        item.contextWindow > 0)) &&
    (item.maxTokens === undefined ||
      (typeof item.maxTokens === 'number' && Number.isSafeInteger(item.maxTokens) && item.maxTokens > 0))
  )
}

function parseDiscoveredModels(value: unknown): readonly DiscoveredModel[] | undefined {
  const root = object(value)
  const rows = Array.isArray(value) ? value : root?.models
  if (!Array.isArray(rows)) return undefined
  return rows.length > 512 || !rows.every(isDiscoveredModel) ? undefined : rows
}

function parseCustomProviderCreateResult(value: unknown): CustomProviderCreateResult | undefined {
  const result = object(value)
  if (
    result === undefined ||
    typeof result.profileCommitted !== 'boolean' ||
    typeof result.credentialConfigured !== 'boolean' ||
    (result.credentialError !== undefined && typeof result.credentialError !== 'string')
  )
    return undefined
  return {
    profileCommitted: result.profileCommitted,
    credentialConfigured: result.credentialConfigured,
    ...(typeof result.credentialError === 'string' && result.credentialError !== ''
      ? { credentialError: result.credentialError.slice(0, 512) }
      : {}),
  }
}

function isAgentConfiguration(value: unknown): value is AgentConfiguration {
  const item = object(value)
  const model = object(item?.model)
  return (
    item !== undefined &&
    typeof item.preset === 'string' &&
    isToolMode(item.toolMode) &&
    isPermissionPreset(item.permissionPreset) &&
    typeof item.planMode === 'boolean' &&
    (item.sandboxMode === undefined || typeof item.sandboxMode === 'string') &&
    (item.approvalPolicy === undefined || typeof item.approvalPolicy === 'string') &&
    model !== undefined &&
    typeof model.providerId === 'string' &&
    typeof model.modelId === 'string' &&
    (model.reasoningLevel === undefined || typeof model.reasoningLevel === 'string')
  )
}

function createDefaultConfiguration(
  state: Pick<AppState, 'presets' | 'models'>,
  preferences: ComposerPreferences,
): AgentConfiguration {
  const defaultPreset =
    state.presets.find((entry) => entry.isDefault)?.id ?? state.presets[0]?.id ?? 'standard'
  const preset =
    preferences.preset !== undefined &&
    (state.presets.length === 0 || state.presets.some((entry) => entry.id === preferences.preset))
      ? preferences.preset
      : defaultPreset
  const model =
    preferences.model !== undefined &&
    (state.models.length === 0 ||
      state.models.some(
        (entry) =>
          entry.providerId === preferences.model?.providerId && entry.id === preferences.model?.modelId,
      ))
      ? preferences.model
      : { providerId: '', modelId: '' }
  return {
    preset,
    toolMode: 'native',
    permissionPreset: 'workspace-write',
    planMode: false,
    model,
  }
}

function readPersistedWebviewState(value: unknown): PersistedWebviewState {
  const root = object(value)
  const raw = object(root?.composerPreferences)
  const preset = typeof raw?.preset === 'string' && raw.preset.trim() !== '' ? raw.preset : undefined
  const model = normalizedModelSelection(raw?.model)
  const openFileId =
    typeof raw?.openFileId === 'string' && raw.openFileId.trim() !== '' ? raw.openFileId : undefined
  const promptMode =
    typeof raw?.promptMode === 'string' && isPromptMode(raw.promptMode) ? raw.promptMode : undefined
  return {
    version: 1,
    composerPreferences: {
      ...(preset === undefined ? {} : { preset }),
      ...(model === undefined ? {} : { model }),
      ...(openFileId === undefined ? {} : { openFileId }),
      ...(promptMode === undefined ? {} : { promptMode }),
    },
    ...(typeof root?.activeSessionId === 'string' && root.activeSessionId.trim() !== ''
      ? { activeSessionId: root.activeSessionId }
      : {}),
  }
}

function normalizedModelSelection(value: unknown): ModelSelection | undefined {
  const model = object(value)
  if (
    model === undefined ||
    typeof model.providerId !== 'string' ||
    typeof model.modelId !== 'string' ||
    model.providerId.trim() === '' ||
    model.modelId.trim() === ''
  )
    return undefined
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(typeof model.reasoningLevel === 'string' && model.reasoningLevel.trim() !== ''
      ? { reasoningLevel: model.reasoningLevel }
      : {}),
  }
}

function applyKnownCommand(configuration: AgentConfiguration, command: string): AgentConfiguration {
  const parts = command.trim().replace(/^\//u, '').split(/\s+/u)
  if (parts[0] === 'permission' && parts[1] !== undefined)
    return { ...configuration, permissionPreset: parts[1], permissionPresetKnown: true }
  if (parts[0] === 'plan') return { ...configuration, planMode: parts[1] !== 'off', planModeKnown: true }
  return configuration
}

function hasDynamicCommand(commands: readonly DynamicCommand[], name: string): boolean {
  const target = name.trim().toLocaleLowerCase()
  return commands.some((command) => command.name.trim().toLocaleLowerCase() === target)
}

function promptModeAfterCommand(current: PromptMode, command: string): PromptMode | undefined {
  const parts = command.trim().replace(/^\//u, '').split(/\s+/u)
  if (parts[0]?.toLocaleLowerCase() !== 'plan') return undefined
  return parts[1]?.toLocaleLowerCase() === 'off' ? (current === 'plan' ? 'ask' : current) : 'plan'
}

function promptModeForConfiguration(preferred: PromptMode, planMode: boolean): PromptMode {
  if (planMode) return 'plan'
  return preferred === 'plan' ? 'ask' : preferred
}

function isToolMode(value: unknown): value is AgentConfiguration['toolMode'] {
  return value === 'native' || value === 'ptc' || value === 'code' || value === 'both'
}

function isPermissionPreset(value: unknown): value is AgentConfiguration['permissionPreset'] {
  return typeof value === 'string' && value.trim() !== ''
}

function isPresetDescriptor(value: unknown): value is AgentPresetDescriptor {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    (item.trust === 'system' || item.trust === 'user') &&
    typeof item.isDefault === 'boolean' &&
    (item.name === undefined || typeof item.name === 'string') &&
    (item.description === undefined || typeof item.description === 'string') &&
    (item.broken === undefined || typeof item.broken === 'string')
  )
}

/** Parse the `agentPreset.list` answer: roster rows plus the deployment facts. */
function parsePresetRoster(value: unknown): AgentPresetRoster | undefined {
  const roster = object(value)
  if (
    roster === undefined ||
    !Array.isArray(roster.presets) ||
    !roster.presets.every(isPresetDescriptor) ||
    typeof roster.authorable !== 'boolean' ||
    // Absent means the host did not state its native-opener capability; a
    // stated value must still be a boolean.
    (roster.hasDocument !== undefined && typeof roster.hasDocument !== 'boolean') ||
    (roster.modeSelectionEnabled !== undefined && typeof roster.modeSelectionEnabled !== 'boolean') ||
    (roster.compositionReadable !== undefined && typeof roster.compositionReadable !== 'boolean') ||
    (roster.defaultSettingPath !== undefined && typeof roster.defaultSettingPath !== 'string')
  )
    return undefined
  return {
    presets: roster.presets,
    ...(typeof roster.compositionReadable === 'boolean'
      ? { compositionReadable: roster.compositionReadable }
      : {}),
    ...(typeof roster.defaultSettingPath === 'string'
      ? { defaultSettingPath: roster.defaultSettingPath }
      : {}),
    authorable: roster.authorable,
    ...(typeof roster.hasDocument === 'boolean' ? { hasDocument: roster.hasDocument } : {}),
    ...(typeof roster.modeSelectionEnabled === 'boolean'
      ? { modeSelectionEnabled: roster.modeSelectionEnabled }
      : {}),
  }
}

const FIBER_PHASES: readonly string[] = ['pending', 'loading', 'active', 'failed', 'unloading']

function isPluginInventoryEntry(value: unknown): value is PluginInventorySnapshot['entries'][number] {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.entryId === 'string' &&
    item.entryId.length > 0 &&
    typeof item.moduleName === 'string' &&
    (item.meta === undefined || isPluginMetadata(item.meta)) &&
    typeof item.enabled === 'boolean' &&
    (item.fiberPhase === null ||
      (typeof item.fiberPhase === 'string' && FIBER_PHASES.includes(item.fiberPhase)))
  )
}

type AgentPresetPluginGroup = NonNullable<PluginInventorySnapshot['agentPresets']>[number]
type AgentPresetPluginRow = AgentPresetPluginGroup['rows'][number]

function isAgentPresetPluginGroup(value: unknown): value is AgentPresetPluginGroup {
  const group = object(value)
  return (
    group !== undefined &&
    typeof group.id === 'string' &&
    group.id.length > 0 &&
    (group.trust === 'system' || group.trust === 'user') &&
    typeof group.isDefault === 'boolean' &&
    Array.isArray(group.rows) &&
    (group.name === undefined || typeof group.name === 'string') &&
    (group.broken === undefined || typeof group.broken === 'string') &&
    group.rows.every(isAgentPresetPluginRow)
  )
}

function isAgentPresetPluginRow(value: unknown): value is AgentPresetPluginRow {
  const row = object(value)
  return (
    row !== undefined &&
    (row.entryId === null || (typeof row.entryId === 'string' && row.entryId.length > 0)) &&
    typeof row.moduleName === 'string' &&
    (row.meta === undefined || isPluginMetadata(row.meta)) &&
    row.moduleName.trim() !== '' &&
    (typeof row.enabled === 'boolean' || row.enabled === 'conditional') &&
    (row.condition === undefined || typeof row.condition === 'string') &&
    (row.fiberPhase === null || (typeof row.fiberPhase === 'string' && FIBER_PHASES.includes(row.fiberPhase)))
  )
}

/** Parse the `pluginInventory/list` projection as one complete snapshot. */
function parsePluginInventory(value: unknown): PluginInventorySnapshot | undefined {
  const snapshot = object(value)
  if (
    snapshot === undefined ||
    !Array.isArray(snapshot.entries) ||
    (snapshot.managementAvailable !== undefined && typeof snapshot.managementAvailable !== 'boolean')
  )
    return undefined
  const entries: PluginInventorySnapshot['entries'][number][] = []
  for (const entry of snapshot.entries) {
    if (!isPluginInventoryEntry(entry)) return undefined
    entries.push(entry)
  }
  const agentPresets = snapshot.agentPresets
  let parsedAgentPresets: AgentPresetPluginGroup[] | undefined
  if (agentPresets !== undefined) {
    if (!Array.isArray(agentPresets)) return undefined
    parsedAgentPresets = []
    for (const group of agentPresets) {
      if (!isAgentPresetPluginGroup(group)) return undefined
      parsedAgentPresets.push(group)
    }
  }
  return {
    entries,
    ...(parsedAgentPresets === undefined ? {} : { agentPresets: parsedAgentPresets }),
    ...(typeof snapshot.managementAvailable === 'boolean'
      ? { managementAvailable: snapshot.managementAvailable }
      : {}),
  }
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function removeMatching<T>(items: readonly T[], matches: (item: T) => boolean): readonly T[] {
  const firstMatch = items.findIndex(matches)
  if (firstMatch === -1) return items
  return items.filter((item) => !matches(item))
}

function sameQueuedInputList(left: readonly QueuedInput[], right: readonly QueuedInput[]): boolean {
  return sameList(
    left,
    right,
    (previous, next) =>
      previous.id === next.id &&
      previous.sessionId === next.sessionId &&
      previous.text === next.text &&
      previous.mode === next.mode &&
      previous.createdAt === next.createdAt &&
      previous.rpcId === next.rpcId &&
      previous.textOnly === next.textOnly &&
      samePromptAttachmentList(previous.attachments, next.attachments) &&
      sameMessageImageList(previous.images, next.images) &&
      sameStringList(previous.files, next.files),
  )
}

function removeAdmittedQueueInput(
  queue: readonly QueuedInput[],
  event: Extract<BackendEvent, { readonly type: 'message.user' }>,
): readonly QueuedInput[] {
  const byRpcId = event.rpcId === undefined ? -1 : queue.findIndex((item) => item.rpcId === event.rpcId)
  const index = byRpcId >= 0 ? byRpcId : queue.findIndex((item) => isAdmittedQueueInput(item, event))
  if (index < 0) return queue
  return [...queue.slice(0, index), ...queue.slice(index + 1)]
}

/**
 * Whether a pending row is the durable message that was just admitted.
 *
 * The two are projections of the same host content, but not of the same
 * fields: the row lists the names of the files it carries — an inlined text
 * file among them — while the durable message reports those names as
 * attachments, and its images are compared by count. Comparing the two lists
 * field by field therefore never matched a row that carried anything, and the
 * dock kept the row until the next queue frame. Correspondence by kind is what
 * identifies the message, mirroring the timeline's preview matcher.
 *
 * The durable message may carry attachments the row never listed: editor
 * context chips are resolved into prompt attachments inside the Extension Host
 * and are appended after the row's own, so the row's names are the leading
 * ones and anything beyond them belongs to content the Webview never queued.
 */
function isAdmittedQueueInput(
  item: QueuedInput,
  event: Extract<BackendEvent, { readonly type: 'message.user' }>,
): boolean {
  if (item.text !== event.markdown) return false
  const names = item.files ?? []
  const attachedNames = (event.attachments ?? []).map((attachment) => attachment.name)
  if (names.length > attachedNames.length) return false
  if (!names.every((name, index) => name === attachedNames[index])) return false
  return (item.images ?? []).length === (event.images ?? []).length
}

function samePromptAttachmentList(
  left: readonly PromptAttachment[],
  right: readonly PromptAttachment[],
): boolean {
  return sameList(
    left,
    right,
    (previous, next) =>
      previous.uri === next.uri && previous.name === next.name && previous.mimeType === next.mimeType,
  )
}

function sameMessageImageList(
  queued: readonly MessageImageReference[] | undefined,
  message: readonly MessageImageReference[] | undefined,
): boolean {
  const left = queued ?? []
  const right = message ?? []
  return (
    left.length === right.length &&
    left.every(
      (image, index) =>
        image.attachmentId === right[index]?.attachmentId &&
        image.mediaType === right[index]?.mediaType &&
        image.bytes === right[index]?.bytes &&
        image.width === right[index]?.width &&
        image.height === right[index]?.height &&
        image.name === right[index]?.name,
    )
  )
}

function sameGoalList(left: readonly GoalView[], right: readonly GoalView[]): boolean {
  return sameList(
    left,
    right,
    (previous, next) =>
      previous.id === next.id &&
      previous.title === next.title &&
      previous.status === next.status &&
      previous.maxGoalRounds === next.maxGoalRounds &&
      previous.activation === next.activation &&
      // The host can republish a still-blocked goal with a different reason;
      // comparing only status would keep showing the superseded one.
      previous.blockedReason?.code === next.blockedReason?.code &&
      previous.blockedReason?.message === next.blockedReason?.message,
  )
}

function sameTodoList(left: readonly TodoView[], right: readonly TodoView[]): boolean {
  return sameList(
    left,
    right,
    (previous, next) =>
      previous.id === next.id && previous.content === next.content && previous.status === next.status,
  )
}

function sameJobList(left: readonly JobView[], right: readonly JobView[]): boolean {
  return sameList(
    left,
    right,
    (previous, next) =>
      previous.id === next.id &&
      previous.kind === next.kind &&
      previous.label === next.label &&
      previous.status === next.status &&
      previous.detail === next.detail &&
      previous.progress === next.progress &&
      previous.startedAt === next.startedAt &&
      previous.finishedAt === next.finishedAt &&
      previous.output?.total === next.output?.total &&
      previous.output?.earliest === next.output?.earliest,
  )
}

function sameList<T>(
  left: readonly T[],
  right: readonly T[],
  equal: (previous: T, next: T) => boolean,
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index]
    const next = right[index]
    if (previous === undefined || next === undefined || !equal(previous, next)) return false
  }
  return true
}

function isDynamicCommand(value: unknown): value is DynamicCommand {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.name === 'string' &&
    /^[a-z][a-z0-9_-]*$/u.test(item.name) &&
    typeof item.description === 'string' &&
    (item.whenToUse === undefined || typeof item.whenToUse === 'string') &&
    (item.input === undefined ||
      (isRecord(item.input) &&
        typeof item.input.hint === 'string' &&
        (item.input.images === undefined || typeof item.input.images === 'boolean'))) &&
    (item.source === undefined ||
      item.source === 'builtin' ||
      item.source === 'skill' ||
      item.source === 'plugin')
  )
}

function isSkillDescriptor(value: unknown): value is SkillDescriptor {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    item.id.trim() !== '' &&
    typeof item.name === 'string' &&
    item.name.trim() !== '' &&
    typeof item.description === 'string' &&
    (item.hasDocument === undefined || typeof item.hasDocument === 'boolean') &&
    (item.whenToUse === undefined || typeof item.whenToUse === 'string') &&
    (item.source === undefined ||
      item.source === 'project' ||
      item.source === 'user' ||
      item.source === 'plugin') &&
    typeof item.enabled === 'boolean'
  )
}

function isGoalView(value: unknown): value is GoalView {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    isGoalStatus(item.status) &&
    (item.activation === undefined || item.activation === 'armed' || item.activation === 'disarmed') &&
    (item.maxGoalRounds === undefined || positiveSafeInteger(item.maxGoalRounds) !== undefined) &&
    (item.blockedReason === undefined || isGoalBlockedReason(item.blockedReason))
  )
}

function isGoalBlockedReason(value: unknown): value is { readonly code: string; readonly message: string } {
  const reason = object(value)
  return reason !== undefined && typeof reason.code === 'string' && typeof reason.message === 'string'
}

function parseGoalViews(value: unknown): readonly GoalView[] | undefined {
  if (!Array.isArray(value)) return undefined
  const goals: GoalView[] = []
  for (const entry of value) {
    if (!isGoalView(entry)) return undefined
    goals.push(entry)
  }
  return goals
}

function parseTodoViews(value: unknown): readonly TodoView[] | undefined {
  if (!Array.isArray(value)) return undefined
  const todos: TodoView[] = []
  for (const entry of value) {
    const item = object(entry)
    if (
      item === undefined ||
      typeof item.id !== 'string' ||
      item.id.length === 0 ||
      typeof item.content !== 'string' ||
      (item.status !== 'pending' && item.status !== 'in-progress' && item.status !== 'completed')
    )
      return undefined
    todos.push({ id: item.id, content: item.content, status: item.status })
  }
  return todos
}

function parseQueuedInputs(value: unknown, sessionId: string): readonly QueuedInput[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items: QueuedInput[] = []
  for (const entry of value) {
    if (!isQueuedInput(entry)) return undefined
    if (entry.sessionId !== sessionId) return undefined
    items.push(entry)
  }
  return items
}

function isJobView(value: unknown): value is JobView {
  const item = object(value)
  const output = object(item?.output)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.kind === 'string' &&
    item.kind.length > 0 &&
    typeof item.label === 'string' &&
    item.label.length > 0 &&
    isJobStatus(item.status) &&
    Number.isSafeInteger(item.startedAt) &&
    (item.startedAt as number) >= 0 &&
    (item.detail === undefined || typeof item.detail === 'string') &&
    (item.progress === undefined || typeof item.progress === 'string') &&
    (item.output === undefined ||
      (output !== undefined &&
        Number.isSafeInteger(output.total) &&
        (output.total as number) >= 0 &&
        Number.isSafeInteger(output.earliest) &&
        (output.earliest as number) >= 0 &&
        (output.earliest as number) <= (output.total as number))) &&
    (item.finishedAt === undefined ||
      (Number.isSafeInteger(item.finishedAt) && (item.finishedAt as number) >= 0))
  )
}

function parseJobFollowFrame(value: unknown): JobFollowFrame | undefined {
  const frame = object(value)
  if (frame === undefined || typeof frame.type !== 'string') return undefined
  if (frame.type === 'opened' && isJobView(frame.job) && isSafeSequenceNumber(frame.from))
    return { type: 'opened', job: frame.job, from: frame.from }
  if (frame.type === 'status' && isJobView(frame.job)) return { type: 'status', job: frame.job }
  if (
    frame.type === 'output' &&
    Array.isArray(frame.chunks) &&
    frame.chunks.every(isJobOutputChunk) &&
    isSafeSequenceNumber(frame.next) &&
    (frame.lossy === undefined || frame.lossy === true)
  )
    return {
      type: 'output',
      chunks: frame.chunks,
      next: frame.next,
      ...(frame.lossy === true ? { lossy: true } : {}),
    }
  return undefined
}

function isJobOutputChunk(value: unknown): value is JobOutputChunk {
  const chunk = object(value)
  return (
    chunk !== undefined &&
    isSafeSequenceNumber(chunk.at) &&
    typeof chunk.text === 'string' &&
    (chunk.channel === undefined ||
      chunk.channel === 'stdout' ||
      chunk.channel === 'stderr' ||
      chunk.channel === 'log') &&
    (chunk.gapBefore === undefined || chunk.gapBefore === true)
  )
}

function isSafeSequenceNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function isTerminalJobStatus(status: JobView['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

function reduceJobFollow(current: JobFollowState, jobId: string, frame: JobFollowFrame): JobFollowState {
  if (current.jobId !== jobId) return current
  if (frame.type === 'opened') {
    if (current.awaitingOpenFrom === undefined || frame.from !== current.awaitingOpenFrom) return current
    return {
      jobId: current.jobId,
      next: Math.max(current.next, frame.from),
      chunks: current.chunks,
      lossy: current.lossy,
      ...(current.generation === undefined ? {} : { generation: current.generation }),
      terminalStatusReceived: false,
      job: frame.job,
    }
  }
  if (current.awaitingOpenFrom !== undefined || current.terminalStatusReceived === true) return current
  const previous = current
  if (frame.type === 'status')
    return {
      ...previous,
      next: Math.max(previous.next, frame.job.output?.total ?? previous.next),
      job: frame.job,
      terminalStatusReceived: isTerminalJobStatus(frame.job.status),
    }
  if (frame.next <= previous.next) return previous
  const additions = frame.chunks.filter((chunk) => chunk.at >= previous.next)
  const byOffset = new Map<number, JobOutputChunk>()
  for (const chunk of previous.chunks) byOffset.set(chunk.at, chunk)
  for (const chunk of additions) byOffset.set(chunk.at, chunk)
  const chunks = [...byOffset.values()].sort((left, right) => left.at - right.at)
  let chars = chunks.reduce((total, chunk) => total + chunk.text.length, 0)
  while (chunks.length > 1 && chars > 256 * 1024) {
    const removed = chunks.shift()
    chars -= removed?.text.length ?? 0
  }
  return {
    ...previous,
    next: frame.next,
    chunks,
    lossy: previous.lossy || frame.lossy === true || frame.chunks.some((chunk) => chunk.gapBefore === true),
  }
}

function isMessageFeedbackItem(value: unknown): value is MessageFeedbackItem {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.messageId === 'string' &&
    item.messageId.length > 0 &&
    (item.rating === 'positive' || item.rating === 'negative') &&
    typeof item.version === 'string' &&
    item.version.length > 0 &&
    (item.note === undefined || typeof item.note === 'string') &&
    (item.category === undefined || isFeedbackCategory(item.category)) &&
    (item.createdAt === undefined ||
      (typeof item.createdAt === 'number' && Number.isSafeInteger(item.createdAt) && item.createdAt >= 0)) &&
    (item.updatedAt === undefined ||
      (typeof item.updatedAt === 'number' && Number.isSafeInteger(item.updatedAt) && item.updatedAt >= 0))
  )
}

function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return (
    value === 'task-result' ||
    value === 'instruction-following' ||
    value === 'product-interaction' ||
    value === 'service-stability' ||
    value === 'resource-cost' ||
    value === 'security-privacy-permission' ||
    value === 'other'
  )
}

function feedbackRecord(
  items: readonly MessageFeedbackItem[],
): Readonly<Record<string, MessageFeedbackItem>> {
  return Object.fromEntries(items.map((item) => [item.messageId, item]))
}

function hasUnsafeReferencePath(value: string): boolean {
  if (value.includes('"')) return true
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
  })
}

function referenceCandidates(value: unknown): readonly ReferenceCandidate[] {
  const record = object(value)
  if (record === undefined) return []
  const candidates: ReferenceCandidate[] = []
  const seen = new Set<string>()
  if (Array.isArray(record.files))
    for (const value of record.files) {
      const item = object(value)
      if (
        item === undefined ||
        typeof item.path !== 'string' ||
        item.path.trim() === '' ||
        item.path.length > 4_096 ||
        hasUnsafeReferencePath(item.path) ||
        (item.kind !== 'file' && item.kind !== 'directory')
      )
        continue
      const id = `file:${item.path}`
      if (seen.has(id)) continue
      seen.add(id)
      candidates.push({
        id,
        kind: item.kind,
        path: item.path,
        label: referenceLabel(item.path),
        description: item.path,
      })
    }
  if (Array.isArray(record.sessions))
    for (const value of record.sessions) {
      const item = object(value)
      if (
        item === undefined ||
        typeof item.sessionId !== 'string' ||
        item.sessionId.trim() === '' ||
        typeof item.label !== 'string' ||
        item.label.trim() === '' ||
        typeof item.sameWorkspace !== 'boolean' ||
        typeof item.mention !== 'string' ||
        !/^@\[[^\]\r\n]{1,512}\]\(dsh-session:[A-Za-z0-9_-]{1,512}\)$/u.test(item.mention)
      )
        continue
      const id = `session:${item.sessionId}`
      if (seen.has(id)) continue
      seen.add(id)
      candidates.push({
        id,
        kind: 'session',
        sessionId: item.sessionId,
        label: item.label,
        description: typeof item.cwd === 'string' && item.cwd !== '' ? item.cwd : item.sessionId,
        mention: item.mention,
        sameWorkspace: item.sameWorkspace,
      })
    }
  return candidates.slice(0, 100)
}

function referenceLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, '')
  const slash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return slash >= 0 && slash + 1 < normalized.length ? normalized.slice(slash + 1) : normalized
}

function isSubagentView(value: unknown): value is SubagentView {
  const item = object(value)
  return (
    item !== undefined &&
    item.kind === 'child' &&
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    (item.label === undefined || typeof item.label === 'string') &&
    (item.mode !== 'continuable' || typeof item.label === 'string') &&
    (item.activity === 'running' || item.activity === 'inactive') &&
    typeof item.parentSessionId === 'string' &&
    item.parentSessionId.length > 0 &&
    (item.mode === 'one-shot' || item.mode === 'continuable') &&
    typeof item.hasChildren === 'boolean'
  )
}

function isSubagentCatalogEntry(value: unknown): value is SubagentCatalog['entries'][number] {
  if (isSubagentView(value)) return true
  const item = object(value)
  return (
    item !== undefined &&
    item.kind === 'diagnostic' &&
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.parentSessionId === 'string' &&
    item.parentSessionId.length > 0 &&
    (item.reason === 'corrupt' || item.reason === 'unsupported' || item.reason === 'unavailable')
  )
}

const WORKFLOW_STATUSES: readonly string[] = ['running', 'completed', 'failed', 'cancelled', 'interrupted']
const MEMBER_STATUSES: readonly string[] = ['running', 'completed', 'failed', 'cancelled', 'interrupted']

function isWorkflowMember(value: unknown): value is WorkflowMember {
  const item = object(value)
  return (
    item !== undefined &&
    Number.isSafeInteger(item.seq) &&
    (item.seq as number) > 0 &&
    typeof item.label === 'string' &&
    typeof item.childId === 'string' &&
    typeof item.status === 'string' &&
    MEMBER_STATUSES.includes(item.status)
  )
}

function isWorkflowStage(value: unknown): value is WorkflowSummary['stages'][number] {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    (typeof item.phase === 'string' || item.phase === null) &&
    Array.isArray(item.members) &&
    item.members.every(isWorkflowMember)
  )
}

function isWorkflowSummary(value: unknown): value is WorkflowSummary {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    typeof item.sessionId === 'string' &&
    typeof item.name === 'string' &&
    typeof item.status === 'string' &&
    WORKFLOW_STATUSES.includes(item.status) &&
    Array.isArray(item.stages) &&
    item.stages.every(isWorkflowStage)
  )
}

function isQueuedInput(value: unknown): value is QueuedInput {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    item.id.trim() !== '' &&
    typeof item.sessionId === 'string' &&
    item.sessionId.trim() !== '' &&
    typeof item.text === 'string' &&
    Array.isArray(item.attachments) &&
    item.attachments.every(isPromptAttachment) &&
    (item.images === undefined ||
      (Array.isArray(item.images) && item.images.every(isMessageImageReference))) &&
    (item.files === undefined ||
      (Array.isArray(item.files) &&
        item.files.every((entry) => typeof entry === 'string' && entry.trim() !== ''))) &&
    typeof item.textOnly === 'boolean' &&
    (item.mode === 'queue' || item.mode === 'steer') &&
    typeof item.createdAt === 'string' &&
    (item.rpcId === undefined || typeof item.rpcId === 'string')
  )
}

function isPromptAttachment(value: unknown): value is PromptAttachment {
  const attachment = object(value)
  return (
    attachment !== undefined &&
    typeof attachment.uri === 'string' &&
    typeof attachment.name === 'string' &&
    (attachment.mimeType === undefined || typeof attachment.mimeType === 'string')
  )
}

function isMessageImageReference(value: unknown): value is MessageImageReference {
  const image = object(value)
  return (
    image !== undefined &&
    typeof image.attachmentId === 'string' &&
    image.attachmentId.trim() !== '' &&
    (image.mediaType === 'image/png' ||
      image.mediaType === 'image/jpeg' ||
      image.mediaType === 'image/webp' ||
      image.mediaType === 'image/gif') &&
    positiveSafeInteger(image.bytes) !== undefined &&
    positiveSafeInteger(image.width) !== undefined &&
    positiveSafeInteger(image.height) !== undefined &&
    (image.name === undefined || typeof image.name === 'string')
  )
}

function nextForkTitle(
  sourceTitle: string,
  sessions: readonly SessionSummary[],
  workspaceId: string,
): string {
  const base = sourceTitle.trim() === '' ? 'New Session' : sourceTitle.trim()
  const taken = new Set(
    sessions
      .filter((session) => session.workspaceId === workspaceId)
      .map((session) => session.title.trim().toLocaleLowerCase()),
  )
  let suffix = 1
  let candidate = `${base} (${suffix})`
  while (taken.has(candidate.toLocaleLowerCase())) {
    suffix += 1
    candidate = `${base} (${suffix})`
  }
  return candidate
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
