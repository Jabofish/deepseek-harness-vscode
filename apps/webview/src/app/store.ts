import {
  parseSlashCommand,
  type AgentConfiguration,
  type AgentPresetDescriptor,
  type AgentPresetDocument,
  type AgentPresetLocation,
  type AgentPresetRoster,
  type BackendEvent,
  type BackendState,
  type DshSettingsSchema,
  type DshUpdateSnapshot,
  type DiscoveredModel,
  type DynamicCommand,
  type ExtensionSettingsSummary,
  type GoalView,
  type JobView,
  type MessageFeedbackItem,
  type MessageFeedbackRating,
  type MessageAttachment,
  type MessageImageReference,
  type ModelDescriptor,
  type ModelDiscoveryInput,
  type ModelProvider,
  type ModelSelection,
  type PermissionRequest,
  type PluginInventorySnapshot,
  type PromptAttachment,
  type QuestionAnswer,
  type QueuedInput,
  type RunningInputMode,
  type SessionConfigurationPatch,
  type SessionExportOptions,
  type SessionHistoryEvent,
  type SessionProjectionSnapshot,
  type SessionSummary,
  type SkillDescriptor,
  type TeamActivityView,
  type SubagentCatalog,
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
  type WorkflowMember,
  type WorkflowSummary,
  type WorkspaceSummary,
} from '@dsh-vscode/domain'
import { isInjectedUserMessage, reduceTimeline, type TimelineState } from '@dsh-vscode/timeline'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'

import { translate } from '../i18n.js'
import { ProtocolClient } from './protocol-client.js'
import { getVsCodeApi } from '../vscode-api.js'

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
    }

/** A paste/drop payload whose bytes the Webview already holds as base64. */
export interface IngestedFile {
  readonly name: string
  readonly mimeType?: string
  readonly dataBase64: string
}

export interface AppState {
  readonly backend: BackendState
  /** Safe connected-host version copied from the Extension Host snapshot. */
  readonly connectedDshVersion: string | undefined
  /** Safe compatibility warning for an unknown/fallback DSH runtime. */
  readonly dshCompatibilityWarning: string | undefined
  /** Latest Host-owned npm registry snapshot for the DSH runtime. */
  readonly dshUpdate: DshUpdateSnapshot | undefined
  readonly sessions: readonly SessionSummary[]
  readonly archivedSessionIds: readonly string[]
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
  readonly presets: readonly AgentPresetDescriptor[]
  readonly permissionPresets: readonly string[]
  readonly commands: readonly DynamicCommand[]
  readonly goals: readonly GoalView[]
  readonly todos: readonly TodoView[]
  readonly jobs: readonly JobView[]
  /** Feedback keyed by assistant message id for the active session. */
  readonly feedback: Readonly<Record<string, MessageFeedbackItem>>
  /** True after the connected DSH explicitly reports that message feedback is unavailable. */
  readonly feedbackUnavailable?: boolean
  /** Complete direct-child catalog for the active ordinary or child session. */
  readonly subagents: SubagentCatalog
  /** Durable address facts retained when a catalog child is opened. */
  readonly activeSubagent: ActiveSubagent | undefined
  readonly queue: readonly QueuedInput[]
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

export interface AppActions {
  initialize(): Promise<void>
  reconnect(): Promise<void>
  refreshSessions(): Promise<void>
  searchSessions(query: string): Promise<readonly SessionSummary[]>
  refreshCommands(sessionId?: string): Promise<void>
  openSession(sessionId: string): Promise<void>
  loadOlderHistory(): Promise<void>
  openSubagent(entry: SubagentView, parentAvailable: boolean): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>
  renameWorkspace(workspaceId: string, name: string): Promise<void>
  removeWorkspace(workspaceId: string): Promise<void>
  moveWorkspace(workspaceId: string, beforeWorkspaceId?: string): Promise<void>
  moveSession(workspaceId: string, sessionId: string, beforeSessionId?: string): Promise<void>
  forkSession(sessionId: string, atSeq?: number): Promise<void>
  createSession(workspaceId?: string, presetId?: string): Promise<void>
  removeSession(sessionId: string): Promise<void>
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
  updateGoal(goalId: string, update: Partial<Pick<GoalView, 'title' | 'status'>>): Promise<void>
  clearGoal(goalId: string): Promise<void>
  updateQueue(inputId: string, text: string): Promise<void>
  removeQueue(inputId: string): Promise<void>
  steerQueue(inputId: string): Promise<void>
  /** Steer every still-queued pending input into the running turn (official empty-draft accelerated Enter). */
  steerAllQueued(): Promise<void>
  loadFeedback(sessionId: string): Promise<void>
  toggleFeedback(sessionId: string, messageId: string, rating: MessageFeedbackRating): Promise<void>
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
  configureProviderSecret(providerId: string, field: string): Promise<boolean>
  removeProviderSecret(providerId: string, field: string): Promise<void>
  refreshModelCatalog(): Promise<void>
  /** Discover provider models through the Host without carrying credentials in the Webview. */
  discoverModels(input: Omit<ModelDiscoveryInput, 'apiKey'>): Promise<readonly DiscoveredModel[]>
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

interface ComposerPreferences {
  readonly preset?: string
  readonly model?: ModelSelection
  readonly openFileId?: string
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

export function createAppStore(client = new ProtocolClient(getVsCodeApi())): AppStore {
  const vscodeApi = getVsCodeApi()
  let persistedWebviewState = readPersistedWebviewState(vscodeApi.getState())
  let composerPreferences = persistedWebviewState.composerPreferences ?? {}
  let state: AppState = {
    backend: { kind: 'idle' },
    connectedDshVersion: undefined,
    dshCompatibilityWarning: undefined,
    dshUpdate: undefined,
    sessions: [],
    archivedSessionIds: [],
    workspaces: [],
    activeSessionId: undefined,
    preferredOpenFileId: composerPreferences.openFileId,
    timeline: { sessionId: undefined, nodes: [], lastSequence: -1 },
    history: [],
    historyHasMore: false,
    historyBeforeSequence: undefined,
    historyLoading: false,
    projections: {},
    configuration: undefined,
    providers: [],
    models: [],
    sessionModels: [],
    presets: [],
    permissionPresets: [],
    commands: [],
    goals: [],
    todos: [],
    jobs: [],
    feedback: {},
    feedbackUnavailable: false,
    subagents: EMPTY_SUBAGENT_CATALOG,
    activeSubagent: undefined,
    queue: [],
    permissions: [],
    questions: [],
    busyEnter: 'queue',
    drawer: undefined,
  }
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  const setState: StateSetter = (next): void => {
    state = typeof next === 'function' ? next(state) : next
    notify()
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
  let openVersion = 0
  const pendingOpens = new Map<number, { readonly sessionId: string; readonly messages: HostMessage[] }>()
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
    setState((current) => (current.activeSessionId === sessionId ? { ...current, commands } : current))
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
    await refreshSessions(client, setState, () => version === refreshVersion)
    if (version === refreshVersion) await refreshCommands()
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
  const executeCommandRequest = async (
    sessionId: string,
    command: string,
    attachments: readonly PromptAttachment[] = [],
  ): Promise<boolean> => {
    const result = object(
      await client.request<unknown>({
        type: 'command.execute',
        requestId: requestId(),
        payload: { sessionId, command, attachments: [...attachments] },
      }),
    )
    if (result?.kind === 'error')
      throw new Error(typeof result.text === 'string' ? result.text : translate('app.error.dshMode'))
    if (result !== undefined && result?.kind !== 'success') throw new Error(translate('app.error.dshMode'))
    setState((current) => {
      if (current.activeSessionId !== sessionId || current.configuration === undefined) return current
      return { ...current, configuration: applyKnownCommand(current.configuration, command) }
    })
    return true
  }
  const unsubscribe = client.subscribe((message) => {
    const messageSessionId = hostMessageSessionId(message)
    let deferredToOpen = false
    if (messageSessionId !== undefined) {
      for (const pending of pendingOpens.values()) {
        if (pending.sessionId !== messageSessionId) continue
        pending.messages.push(message)
        deferredToOpen = true
      }
    }
    // A session can be reopened while it is still active. Applying its live
    // event immediately and replaying it over the freshly hydrated history
    // would duplicate deltas, queue rows, and interaction requests. Defer
    // only events addressed to an in-flight open; global connection/workspace
    // events continue to update the shell while the read is in progress.
    if (!deferredToOpen) applyHostMessage(message, state, setState)
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
      message.name === 'remote.event' &&
      isCommandDirectoryRefresh(message.payload)
    )
      void refreshCommands(undefined, true)
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
    }
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
    if (message.type === 'event' && message.name === 'session.subscribed') {
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
  const open = async (sessionId: string): Promise<void> => {
    const version = ++openVersion
    const pending = { sessionId, messages: [] as HostMessage[] }
    pendingOpens.set(version, pending)
    try {
      const result = await client.request<unknown>({
        type: 'session.open',
        requestId: requestId(),
        payload: { sessionId },
      })
      const detail = object(result)
      const rawHistory = Array.isArray(detail?.history) ? detail.history : []
      const timeline = hydrateTimeline(sessionId, rawHistory)
      const history = parseSessionHistory(rawHistory)
      const permissionPresets = stringList(detail?.permissionPresets)
      const [queue, goals, jobs, feedback, subagents, commands, sessionModels] = await Promise.all([
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
        safeFeedbackList(client, sessionId),
        loadSubagentCatalog(sessionId),
        loadCommandDirectory(sessionId),
        loadSessionModelDirectory(client, sessionId),
      ])
      if (version !== openVersion) return
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
            projections: setSessionProjection(current.projections, sessionId, detail?.projection),
            sessions: upsertOpenedSession(current.sessions, detail, sessionId),
            configuration: isAgentConfiguration(detail?.configuration)
              ? detail.configuration
              : createDefaultConfiguration(current, composerPreferences),
            sessionModels: sessionModels ?? [],
            permissionPresets: permissionPresets ?? [],
            queue,
            goals,
            todos: latestTodos(timeline),
            jobs,
            feedback: feedbackRecord(feedback.items),
            feedbackUnavailable: feedback.unavailable,
            subagents: subagents ?? EMPTY_SUBAGENT_CATALOG,
            activeSubagent: undefined,
            commands:
              commands ??
              commandDirectoryCache.get(sessionId) ??
              (current.activeSessionId === sessionId ? current.commands : []),
          },
          pending.messages,
        ),
      )
      persistWebviewState({ activeSessionId: sessionId })
    } finally {
      pendingOpens.delete(version)
    }
  }
  const openSubagent = async (entry: SubagentView, parentAvailable: boolean): Promise<void> => {
    const version = ++openVersion
    const pending = { sessionId: entry.id, messages: [] as HostMessage[] }
    pendingOpens.set(version, pending)
    const workspaceId =
      state.sessions.find((session) => session.id === state.activeSessionId)?.workspaceId ??
      state.activeSubagent?.workspaceId ??
      ''
    try {
      const [history, queue, goals, jobs, feedback, subagents] = await Promise.all([
        client
          .request<unknown>({
            type: 'subagent.history',
            requestId: requestId(),
            payload: { sessionId: entry.id },
          })
          .then(parseSubagentHistory),
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
        safeFeedbackList(client, entry.id),
        loadSubagentCatalog(entry.id),
      ])
      if (version !== openVersion) return
      const timeline = hydrateTimeline(entry.id, history.events)
      setState((current) =>
        replayHostMessages(
          {
            ...current,
            activeSessionId: entry.id,
            activeSubagent: { entry, parentAvailable, workspaceId },
            timeline,
            history: history.events,
            historyHasMore: false,
            historyBeforeSequence: undefined,
            historyLoading: false,
            projections: setSessionProjection(current.projections, entry.id, history.projection),
            configuration: undefined,
            sessionModels: [],
            permissionPresets: [],
            queue,
            goals,
            todos: latestTodos(timeline),
            jobs,
            feedback: feedbackRecord(feedback.items),
            feedbackUnavailable: feedback.unavailable,
            subagents: subagents ?? EMPTY_SUBAGENT_CATALOG,
            commands: [],
          },
          pending.messages,
        ),
      )
      persistWebviewState({ activeSessionId: entry.id })
    } finally {
      pendingOpens.delete(version)
    }
  }
  callbacks.openCreatedSession = open
  const checkDshUpdates = async (force = false): Promise<DshUpdateSnapshot | undefined> => {
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
    get dshCompatibilityWarning() {
      return state.dshCompatibilityWarning
    },
    get dshUpdate() {
      return state.dshUpdate
    },
    get sessions() {
      return state.sessions
    },
    get archivedSessionIds() {
      return state.archivedSessionIds
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
    get presets() {
      return state.presets
    },
    get permissionPresets() {
      return state.permissionPresets
    },
    get commands() {
      return state.commands
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
    get feedback() {
      return state.feedback
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
      await refresh()
      // Official ui-conversation row: the host-side busy-Enter preference is
      // the composer's plain-Enter policy while a turn is running. A failed
      // read keeps the official default ('queue').
      await applyBusyEnterPreference()
      const rememberedSessionId = persistedWebviewState.activeSessionId
      const startupSession = selectStartupSession(state.sessions, rememberedSessionId)
      if (startupSession !== undefined) await open(startupSession.id)
    },
    reconnect: async () => {
      await client.request<unknown>({ type: 'connection.retry', requestId: requestId() })
      await refresh()
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
      const items = object(result)?.items
      return Array.isArray(items) ? items.filter(isSessionSummary) : []
    },
    refreshCommands: (sessionId) => refreshCommands(sessionId),
    openSession: open,
    loadOlderHistory: async () => {
      const sessionId = state.activeSessionId
      const beforeSeq = state.historyBeforeSequence
      if (
        sessionId === undefined ||
        state.activeSubagent !== undefined ||
        !state.historyHasMore ||
        beforeSeq === undefined ||
        state.historyLoading
      )
        return
      setState((current) =>
        current.activeSessionId === sessionId ? { ...current, historyLoading: true } : current,
      )
      try {
        const result = await client.request<unknown>({
          type: 'session.history',
          requestId: requestId(),
          payload: { sessionId, beforeSeq, maxMessages: 200 },
        })
        const page = parseSessionHistoryPage(result)
        const current = state
        if (current.activeSessionId !== sessionId) return
        const currentBase = current.historyBeforeSequence ?? oldestHistorySequence(current.history)
        const pageNewest = newestHistorySequence(page.events)
        if (pageNewest !== undefined && currentBase !== undefined && pageNewest >= currentBase)
          throw new Error(translate('app.error.historyDiscontinuous'))
        const history = mergeHistory(current.history, page.events)
        const timeline = hydrateTimeline(sessionId, history)
        const nextBefore = page.beforeSequence ?? oldestHistorySequence(page.events)
        const hasMore =
          page.hasMore && nextBefore !== undefined && (currentBase === undefined || nextBefore < currentBase)
        setState((next) =>
          next.activeSessionId === sessionId
            ? {
                ...next,
                timeline,
                history,
                historyHasMore: hasMore,
                historyBeforeSequence: nextBefore,
                historyLoading: false,
                projections:
                  page.projection === undefined
                    ? next.projections
                    : setSessionProjection(next.projections, sessionId, page.projection),
                todos: latestTodos(timeline),
              }
            : next,
        )
      } finally {
        if (state.activeSessionId === sessionId && state.historyLoading)
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
      const acceptedTitle = typeof result?.title === 'string' ? result.title : title.trim()
      setState((current) => ({
        ...current,
        sessions: current.sessions.map((session) =>
          session.id === sessionId ? { ...session, title: acceptedTitle } : session,
        ),
      }))
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
          await open(childId)
          throw reason
        }
      }
      await open(childId)
    },
    configureSession: async (sessionId, configuration) => {
      const generation = ++configurationGeneration
      await client.request<unknown>({
        type: 'session.configure',
        requestId: requestId(),
        payload: { sessionId, configuration },
      })
      if (generation !== configurationGeneration) return
      rememberComposerConfiguration(configuration)
      setState((current) => (current.activeSessionId === sessionId ? { ...current, configuration } : current))
    },
    executeCommand: executeCommandRequest,
    createSession: async (workspaceId, presetId) => {
      const workspace =
        (workspaceId === undefined
          ? undefined
          : state.workspaces.find((entry) => entry.id === workspaceId)) ?? state.workspaces[0]
      const defaultConfiguration = createDefaultConfiguration(state, composerPreferences)
      const configuration =
        presetId === undefined ? defaultConfiguration : { ...defaultConfiguration, preset: presetId }
      const result = await client.request<unknown>({
        type: 'session.create',
        requestId: requestId(),
        payload: {
          ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
          configuration,
        },
      })
      const created = object(result)
      await refresh()
      if (typeof created?.id === 'string') await open(created.id)
    },
    removeSession: async (sessionId) => {
      const wasActive = state.activeSessionId === sessionId
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
        ...(wasActive
          ? {
              activeSessionId: undefined,
              timeline: { sessionId: undefined, nodes: [], lastSequence: -1 },
              history: [],
              historyHasMore: false,
              historyBeforeSequence: undefined,
              historyLoading: false,
              projections: removeSessionProjection(current.projections, sessionId),
              configuration: undefined,
              sessionModels: [],
              permissionPresets: [],
              queue: [],
              goals: [],
              todos: [],
              jobs: [],
              feedback: {},
              feedbackUnavailable: false,
              subagents: EMPTY_SUBAGENT_CATALOG,
              activeSubagent: undefined,
              commands: [],
            }
          : {}),
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
      if (wasActive) {
        const replacement = state.sessions[0]
        if (replacement !== undefined) await open(replacement.id)
      }
    },
    sendPrompt: async (sessionId, text, attachments, mode) => {
      const rpcRequestId = requestId()
      const optimisticId = `optimistic:user:${rpcRequestId}`
      const subagent =
        state.activeSessionId === sessionId && state.activeSubagent?.entry.id === sessionId
          ? state.activeSubagent
          : undefined
      if (subagent !== undefined) {
        if (subagent.entry.mode === 'one-shot') throw new Error(translate('app.error.subagentReadOnly'))
        if (!subagent.parentAvailable) throw new Error(translate('app.error.subagentParentUnavailable'))
        if (attachments.length > 0) throw new Error(translate('app.error.subagentAttachments'))
        if (text.trim() === '') throw new Error(translate('app.error.subagentMessageRequired'))
      }
      const isSlashCommand =
        subagent === undefined && attachments.length === 0 && parseSlashCommand(text) !== undefined
      if (isSlashCommand) {
        // Slash commands are control-plane operations.  Sending them through
        // session.prompt turns /plan, /permission, /compact, and every plugin
        // command into a visible model request.  The official WebUI routes
        // the complete line through commands.execute instead.
        await executeCommandRequest(sessionId, text)
        return
      }
      const messageAttachments: readonly MessageAttachment[] = attachments.map((attachment) => ({
        name: attachment.name,
        ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
      }))
      if (text !== '' || messageAttachments.length > 0)
        setState((current) => {
          if (current.activeSessionId !== sessionId) return current
          return {
            ...current,
            timeline: {
              ...current.timeline,
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
            payload: { sessionId, text, attachments: [...attachments], mode },
          })
        else
          await client.request<unknown>({
            type: 'subagent.send',
            requestId: rpcRequestId,
            payload: { sessionId, message: text },
          })
      } catch (reason) {
        setState((current) => ({
          ...current,
          timeline: {
            ...current.timeline,
            nodes: current.timeline.nodes.filter((node) => node.id !== optimisticId),
          },
        }))
        throw reason
      }
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
      if (update.title === undefined && update.status === undefined) return
      await client.request<unknown>({
        type: 'goal.update',
        requestId: requestId(),
        payload: { goalId, ...update },
      })
      setState((current) => ({
        ...current,
        goals: current.goals.map((goal) => (goal.id === goalId ? { ...goal, ...update } : goal)),
      }))
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
      const result = await safeFeedbackList(client, sessionId)
      setState((current) =>
        current.activeSessionId === sessionId
          ? {
              ...current,
              feedback: feedbackRecord(result.items),
              feedbackUnavailable: result.unavailable,
            }
          : current,
      )
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
    loadPresetRoster: async () => {
      const roster = parsePresetRoster(
        await client.request<unknown>({ type: 'preset.list', requestId: requestId() }),
      )
      if (roster !== undefined)
        setState((current) =>
          arraysEqual(current.presets, roster.presets) ? current : { ...current, presets: roster.presets },
        )
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
      unsubscribe()
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
    modelsResult.status === 'fulfilled' ? listValues(modelsResult.value).filter(isModelDescriptor) : undefined
  setState((current) => ({
    ...current,
    ...(providers === undefined ? {} : { providers }),
    ...(models === undefined ? {} : { models }),
  }))
}

function parseExtensionSettings(value: unknown): ExtensionSettingsSummary | undefined {
  const settings = object(value)
  const connection = object(settings?.connection)
  const runtime = object(settings?.runtime)
  const security = object(settings?.security)
  const defaultAgent = object(settings?.defaultAgent)
  if (
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
): Promise<void> {
  const results = await Promise.allSettled([
    client.request<unknown>({
      type: 'session.list',
      requestId: requestId(),
      payload: { archived: false },
    }),
    client.request<unknown>({ type: 'workspace.list', requestId: requestId() }),
    client.request<unknown>({ type: 'providers.list', requestId: requestId() }),
    client.request<unknown>({ type: 'models.list', requestId: requestId(), payload: {} }),
    client.request<unknown>({ type: 'preset.list', requestId: requestId() }),
  ])
  const value = (index: number): unknown => {
    const result = results[index]
    return result?.status === 'fulfilled' ? result.value : undefined
  }
  const sessionItems = object(value(0))?.items
  const workspacePayload = object(value(1))
  const archivedFromHost = stringList(workspacePayload?.archivedSessionIds)
  const rawSessions = Array.isArray(sessionItems) ? sessionItems.filter(isSessionSummary) : undefined
  if (!isCurrent()) return
  setState((current) => {
    // Keep local archive knowledge monotonic while the host publishes the
    // archive-set echo. This prevents a stale concurrent session.list from
    // reintroducing the row that was just archived.
    const archivedSessionIds = uniqueStrings([...current.archivedSessionIds, ...(archivedFromHost ?? [])])
    const archived = new Set(archivedSessionIds)
    const sessions = rawSessions?.filter((session) => !archived.has(session.id))
    const listedSessions = sessions ?? current.sessions.filter((session) => !archived.has(session.id))
    // A DSH workspace attach and its session.list projection can commit in
    // adjacent turns. Do not discard the active conversation merely because a
    // refresh observed that short window without its row. The authoritative
    // archive set is the only refresh result that is allowed to remove it.
    const activeSession =
      current.activeSessionId === undefined
        ? undefined
        : current.sessions.find((session) => session.id === current.activeSessionId)
    const nextSessions =
      activeSession !== undefined &&
      !archived.has(activeSession.id) &&
      !listedSessions.some((session) => session.id === activeSession.id)
        ? [...listedSessions, activeSession]
        : listedSessions
    const activeSessionIsArchived =
      current.activeSessionId !== undefined && archived.has(current.activeSessionId)
    const hasVisibilitySnapshot = rawSessions !== undefined || archivedFromHost !== undefined
    return {
      ...current,
      sessions: nextSessions,
      archivedSessionIds,
      workspaces: listValues(value(1)).filter(isWorkspaceSummary),
      providers: listValues(value(2)).filter(isModelProvider),
      models: listValues(value(3)).filter(isModelDescriptor),
      presets: parsePresetRoster(value(4))?.presets ?? current.presets,
      ...(hasVisibilitySnapshot && activeSessionIsArchived
        ? {
            activeSessionId: undefined,
            timeline: { sessionId: undefined, nodes: [], lastSequence: -1 },
            history: [],
            historyHasMore: false,
            historyBeforeSequence: undefined,
            historyLoading: false,
            projections: {},
            configuration: undefined,
            sessionModels: [],
            permissionPresets: [],
            queue: [],
            goals: [],
            todos: [],
            jobs: [],
            feedback: {},
            feedbackUnavailable: false,
            subagents: EMPTY_SUBAGENT_CATALOG,
            activeSubagent: undefined,
            commands: [],
          }
        : {}),
    }
  })
}

/**
 * Restore the last explicit session when possible. A fresh Webview can lose
 * its persisted id while the DSH session registry is already populated, so
 * fall back to the most recent active root session and then the most recent
 * non-blank root session instead of presenting a misleading "new session"
 * posture.
 */
function selectStartupSession(
  sessions: readonly SessionSummary[],
  rememberedSessionId: string | undefined,
): SessionSummary | undefined {
  const remembered =
    rememberedSessionId === undefined
      ? undefined
      : sessions.find((session) => session.id === rememberedSessionId)
  if (remembered !== undefined) return remembered

  const rootSessions = sessions
    .filter((session) => session.origin !== 'subagent' && !session.blank)
    .sort((left, right) => sessionRecency(right) - sessionRecency(left))
  return (
    rootSessions.find((session) => session.status === 'running' || session.status === 'awaiting-input') ??
    rootSessions[0]
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
): Promise<readonly T[]> {
  try {
    const result = await client.request<unknown>(request)
    return listValues(result).filter(guard)
  } catch {
    return []
  }
}

interface FeedbackListResult {
  readonly items: readonly MessageFeedbackItem[]
  readonly unavailable: boolean
}

async function safeFeedbackList(client: ProtocolClient, sessionId: string): Promise<FeedbackListResult> {
  try {
    const result = await client.request<unknown>({
      type: 'feedback.list',
      requestId: requestId(),
      payload: { sessionId },
    })
    return {
      items: listValues(result).filter(isMessageFeedbackItem),
      unavailable: false,
    }
  } catch (error) {
    return { items: [], unavailable: isFeedbackCapabilityUnavailable(error) }
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
  return {
    events: page.events,
    hasMore: page.hasMore,
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
    commandsResult.status === 'fulfilled' ? listValues(commandsResult.value).filter(isDynamicCommand) : []
  const skills =
    skillsResult.status === 'fulfilled' ? listValues(skillsResult.value).filter(isSkillDescriptor) : []
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
        source: 'skill' as const,
      },
    ]
  })
  return [...commands, ...skillCommands]
}

async function loadSessionModelDirectory(
  client: ProtocolClient,
  sessionId: string,
): Promise<readonly ModelDescriptor[] | undefined> {
  try {
    const result = object(
      await client.request<unknown>({
        type: 'models.session.list',
        requestId: requestId(),
        payload: { sessionId },
      }),
    )
    if (result === undefined || !Array.isArray(result.models)) return undefined
    return result.models.filter(isModelDescriptor)
  } catch {
    return undefined
  }
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

function applyHostMessage(message: HostMessage, state: AppState, setState: StateSetter): void {
  if (message.type !== 'event') return
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
    if (kind === 'runtime-missing') {
      const searchedLocations = Array.isArray(snapshot?.searchedLocations)
        ? snapshot.searchedLocations.filter((entry): entry is string => typeof entry === 'string')
        : []
      setState({
        ...state,
        backend: { kind, searchedLocations },
        connectedDshVersion: undefined,
        dshCompatibilityWarning: undefined,
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
          ...state,
          connectedDshVersion: undefined,
          dshCompatibilityWarning: undefined,
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
          ...state,
          connectedDshVersion: undefined,
          dshCompatibilityWarning: undefined,
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
          ...state,
          backend: { kind } as BackendState,
          connectedDshVersion:
            kind === 'connected' && typeof snapshot?.dshVersion === 'string'
              ? snapshot.dshVersion
              : undefined,
          dshCompatibilityWarning:
            kind === 'connected' && typeof snapshot?.compatibilityWarning === 'string'
              ? snapshot.compatibilityWarning
              : undefined,
        })
    }
    return
  }
  const event = domainEvent(message.name, message.payload)
  if (event === undefined) return
  const eventSessionId = backendEventSessionId(event)
  const belongsToActiveSession = eventSessionId === undefined || eventSessionId === state.activeSessionId
  const controlPlaneMessage = event.type === 'message.user' && isCommandMessageSource(event.source)
  const history =
    state.activeSessionId !== undefined &&
    eventSessionId === state.activeSessionId &&
    event.sequence !== undefined
      ? mergeHistory(state.history, [
          {
            sequence: event.sequence,
            time: historyTime(event),
            event,
          },
        ])
      : state.history
  // Command records are control-plane history and stay out of both Chat and
  // Trajectory.  Other producer-owned user/message records are retained as
  // context nodes; Chat filters those nodes while Trajectory exposes their
  // provenance, matching the upstream target-specific projections.
  const timeline = !belongsToActiveSession
    ? state.timeline
    : controlPlaneMessage
      ? state.timeline
      : reduceTimeline(state.timeline, {
          sequence: event.sequence ?? message.sequence,
          event,
          // Some DSH lifecycle/projection events carry the durable DSH
          // sequence even though they are not timeline records. They must
          // never move the conversation cursor: doing so can make the next
          // live delta look stale until history is replayed after switching
          // sessions.
          ...(!advancesTimelineSequence(event) ? { advanceSequence: false } : {}),
        })
  let next = { ...state, timeline, history }
  if (event.type === 'session.status') {
    const activity = event.status === 'running' ? 'running' : 'inactive'
    next = {
      ...next,
      sessions: next.sessions.map((session) =>
        session.id !== event.sessionId
          ? session
          : {
              ...session,
              status: sessionStatus(event.status),
              ...(event.status === 'running' ? { blank: false } : {}),
            },
      ),
      subagents: {
        ...next.subagents,
        entries: next.subagents.entries.map((entry) =>
          entry.kind === 'child' && entry.id === event.sessionId ? { ...entry, activity } : entry,
        ),
      },
      activeSubagent:
        next.activeSubagent?.entry.id === event.sessionId
          ? {
              ...next.activeSubagent,
              entry: { ...next.activeSubagent.entry, activity },
            }
          : next.activeSubagent,
    }
  } else if (event.type === 'session.title' && event.title.trim() !== '') {
    next = {
      ...next,
      sessions: next.sessions.map((session) =>
        session.id === event.sessionId && !session.blank ? { ...session, title: event.title } : session,
      ),
    }
  } else if (event.type === 'session.projection') {
    next = {
      ...next,
      projections: updateSessionProjection(next.projections, event.sessionId, event.key, event.value),
    }
    if (event.key === 'title' && typeof event.value === 'string') {
      const title = event.value.trim()
      if (title !== '')
        next = {
          ...next,
          sessions: next.sessions.map((session) =>
            session.id === event.sessionId && !session.blank ? { ...session, title } : session,
          ),
        }
    }
  } else if (event.type === 'session.subscribed' && event.sessionId === next.activeSessionId) {
    // queue/jobs and pending interactions are process-local snapshots. The
    // pinned mux starts every subscription with `session/subscribed` and only
    // follows it with a queue/jobs frame when that snapshot is non-empty.
    next = {
      ...next,
      queue: [],
      jobs: [],
      permissions: next.permissions.filter((request) => request.sessionId !== event.sessionId),
      questions: next.questions.filter((question) => question.sessionId !== event.sessionId),
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
    const wasActive = next.activeSessionId === event.sessionId
    next = {
      ...next,
      sessions: next.sessions.filter((session) => session.id !== event.sessionId),
      subagents: {
        ...next.subagents,
        entries: next.subagents.entries.filter((entry) => entry.id !== event.sessionId),
      },
      ...(wasActive
        ? {
            activeSessionId: undefined,
            timeline: { sessionId: undefined, nodes: [], lastSequence: -1 },
            history: [],
            historyHasMore: false,
            historyBeforeSequence: undefined,
            historyLoading: false,
            projections: removeSessionProjection(next.projections, event.sessionId),
            configuration: undefined,
            sessionModels: [],
            permissionPresets: [],
            queue: [],
            goals: [],
            todos: [],
            jobs: [],
            feedback: {},
            feedbackUnavailable: false,
            subagents: EMPTY_SUBAGENT_CATALOG,
            activeSubagent: undefined,
            commands: [],
          }
        : {}),
    }
  } else if (event.type === 'session.added' && event.origin === 'subagent') {
    next = {
      ...next,
      subagents: {
        ...next.subagents,
        entries: next.subagents.entries.map((entry) =>
          entry.kind === 'child' && entry.id === event.parentSessionId
            ? { ...entry, hasChildren: true }
            : entry,
        ),
      },
    }
  } else if (event.type === 'message.user') {
    // A command-only session remains blank. The first real user message is
    // the rc.6 boundary that turns the reusable placeholder into history.
    next = {
      ...next,
      sessions: next.sessions.map((session) =>
        session.id === event.sessionId &&
        !isCommandMessageSource(event.source) &&
        !isInjectedUserMessage(event)
          ? { ...session, blank: false }
          : session,
      ),
    }
  } else if (event.type === 'queue.updated' && event.sessionId === next.activeSessionId) {
    next = { ...next, queue: event.items }
  } else if (event.type === 'goal.updated' && event.sessionId === next.activeSessionId) {
    next = { ...next, goals: event.goals }
  } else if (event.type === 'todo.updated' && event.sessionId === next.activeSessionId) {
    next = { ...next, todos: event.todos }
  } else if (event.type === 'jobs.updated' && event.sessionId === next.activeSessionId) {
    next = { ...next, jobs: event.jobs }
  } else if (event.type === 'permission.resolved' && event.sessionId === next.activeSessionId) {
    next = {
      ...next,
      permissions: next.permissions.filter((request) => request.id !== event.requestId),
    }
  } else if (event.type === 'question.resolved' && event.sessionId === next.activeSessionId) {
    next = {
      ...next,
      questions: next.questions.filter(
        (question) =>
          question.id !== event.questionId &&
          (event.questionRpcId === undefined || question.rpcId !== event.questionRpcId),
      ),
    }
  } else if (event.type === 'permission.requested' && event.request.sessionId === next.activeSessionId) {
    next = {
      ...next,
      permissions: [...next.permissions.filter((request) => request.id !== event.request.id), event.request],
    }
  } else if (event.type === 'question.requested' && event.question.sessionId === next.activeSessionId) {
    next = {
      ...next,
      questions: [...next.questions.filter((question) => question.id !== event.question.id), event.question],
    }
  } else if (event.type === 'connection.lost') {
    next = {
      ...next,
      backend: { kind: 'failed', message: event.reason, retryable: true },
      connectedDshVersion: undefined,
      dshCompatibilityWarning: undefined,
      queue: [],
      jobs: [],
      feedback: {},
      feedbackUnavailable: false,
      permissions: [],
      questions: [],
      subagents: EMPTY_SUBAGENT_CATALOG,
      activeSubagent:
        next.activeSubagent === undefined ? undefined : { ...next.activeSubagent, parentAvailable: false },
      commands: [],
    }
  }
  setState(next)
}

function replayHostMessages(state: AppState, messages: readonly HostMessage[]): AppState {
  let replayed = state
  const setReplayed: StateSetter = (next) => {
    replayed = typeof next === 'function' ? next(replayed) : next
  }
  for (const message of messages) applyHostMessage(message, replayed, setReplayed)
  return replayed
}

function hostMessageSessionId(message: HostMessage): string | undefined {
  if (message.type !== 'event') return undefined
  const event = domainEvent(message.name, message.payload)
  if (event === undefined) return undefined
  return backendEventSessionId(event)
}

function backendEventSessionId(event: BackendEvent): string | undefined {
  if ('sessionId' in event && typeof event.sessionId === 'string') return event.sessionId
  if ('request' in event && typeof event.request.sessionId === 'string') return event.request.sessionId
  if ('question' in event && typeof event.question.sessionId === 'string') return event.question.sessionId
  if ('retry' in event && typeof event.retry.sessionId === 'string') return event.retry.sessionId
  return undefined
}

/** Only durable conversation records advance the DSH timeline cursor. */
function advancesTimelineSequence(event: BackendEvent): boolean {
  switch (event.type) {
    case 'archived.sessions.changed':
    case 'connection.lost':
    case 'session.added':
    case 'session.configuration':
    case 'session.projection':
    case 'session.removed':
    case 'session.status':
    case 'session.subscribed':
    case 'session.title':
    case 'workspace.changed':
    case 'workspace.order.changed':
    case 'workspace.removed':
    case 'remote.event':
    case 'notice':
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

function configurationPatch(value: Record<string, unknown>): SessionConfigurationPatch {
  const model = isRecord(value.model)
    ? {
        ...(typeof value.model.providerId === 'string' ? { providerId: value.model.providerId } : {}),
        ...(typeof value.model.modelId === 'string' ? { modelId: value.model.modelId } : {}),
        ...(typeof value.model.reasoningLevel === 'string'
          ? { reasoningLevel: value.model.reasoningLevel }
          : {}),
      }
    : undefined
  return {
    ...(typeof value.preset === 'string' ? { preset: value.preset } : {}),
    ...(isToolMode(value.toolMode) ? { toolMode: value.toolMode } : {}),
    ...(typeof value.permissionPreset === 'string' ? { permissionPreset: value.permissionPreset } : {}),
    ...(typeof value.planMode === 'boolean' ? { planMode: value.planMode } : {}),
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
): AppState['projections'] {
  const record = object(projection)
  const values = object(record?.values)
  return values === undefined ? projections : { ...projections, [sessionId]: values }
}

function updateSessionProjection(
  projections: AppState['projections'],
  sessionId: string,
  key: string,
  value: unknown,
): AppState['projections'] {
  return {
    ...projections,
    [sessionId]: { ...(projections[sessionId] ?? {}), [key]: value },
  }
}

function removeSessionProjection(
  projections: AppState['projections'],
  sessionId: string,
): AppState['projections'] {
  const remaining = { ...projections }
  delete remaining[sessionId]
  return remaining
}

function domainEvent(name: string, payload: unknown): BackendEvent | undefined {
  const event = parseDomainEvent(name, payload)
  if (event === undefined) return undefined
  const sequence = finiteEventSequence(object(payload)?.sequence)
  return sequence === undefined ? event : { ...event, sequence }
}

function parseDomainEvent(name: string, payload: unknown): BackendEvent | undefined {
  const value = object(payload)
  if (value === undefined) return { type: 'unknown', name, payload }
  if (
    name === 'message.user' &&
    typeof value.sessionId === 'string' &&
    typeof value.messageId === 'string' &&
    typeof value.markdown === 'string'
  ) {
    const attachments = messageAttachments(value.attachments)
    const images = messageImages(value.images)
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
    }
  }
  if ((name === 'turn.started' || name === 'turn.ended') && typeof value.sessionId === 'string') {
    const turn = finiteEventIndex(value.turn)
    if (turn === undefined) return { type: 'unknown', name, payload }
    if (name === 'turn.started') return { type: 'turn.started', sessionId: value.sessionId, turn }
    return {
      type: 'turn.ended',
      sessionId: value.sessionId,
      turn,
      reason: turnEndReason(value.reason),
    }
  }
  if ((name === 'step.started' || name === 'step.ended') && typeof value.sessionId === 'string') {
    const turn = finiteEventIndex(value.turn)
    const step = finiteEventIndex(value.step)
    if (turn === undefined || step === undefined) return { type: 'unknown', name, payload }
    const time = finiteEventTimestamp(value.time)
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
    typeof value.sessionId === 'string' &&
    typeof value.messageId === 'string' &&
    typeof value.delta === 'string'
  ) {
    const turn = finiteEventIndex(value.turn)
    const step = finiteEventIndex(value.step)
    const time = finiteEventTimestamp(value.time)
    return {
      type: 'message.delta',
      sessionId: value.sessionId,
      messageId: value.messageId,
      delta: value.delta,
      ...(turn === undefined ? {} : { turn }),
      ...(step === undefined ? {} : { step }),
      ...(time === undefined ? {} : { time }),
      ...(value.interrupted === true ? { interrupted: true as const } : {}),
    }
  }
  if (
    name === 'reasoning.delta' &&
    typeof value.sessionId === 'string' &&
    typeof value.messageId === 'string' &&
    typeof value.delta === 'string'
  ) {
    const turn = finiteEventIndex(value.turn)
    const step = finiteEventIndex(value.step)
    const time = finiteEventTimestamp(value.time)
    return {
      type: 'reasoning.delta',
      sessionId: value.sessionId,
      messageId: value.messageId,
      delta: value.delta,
      ...(turn === undefined ? {} : { turn }),
      ...(step === undefined ? {} : { step }),
      ...(time === undefined ? {} : { time }),
    }
  }
  if (
    name === 'message.completed' &&
    typeof value.sessionId === 'string' &&
    typeof value.messageId === 'string'
  ) {
    const usage = parseTokenUsage(value.usage)
    const images = messageImages(value.images)
    const turn = finiteEventIndex(value.turn)
    const step = finiteEventIndex(value.step)
    const time = finiteEventTimestamp(value.time)
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
    }
  }
  if (name === 'session.status' && typeof value.sessionId === 'string' && typeof value.status === 'string')
    return { type: 'session.status', sessionId: value.sessionId, status: value.status }
  if (
    name === 'session.subscribed' &&
    typeof value.sessionId === 'string' &&
    typeof value.lastSequence === 'number' &&
    Number.isSafeInteger(value.lastSequence)
  )
    return {
      type: 'session.subscribed',
      sessionId: value.sessionId,
      lastSequence: value.lastSequence,
    }
  if (name === 'session.title' && typeof value.sessionId === 'string' && typeof value.title === 'string')
    return { type: 'session.title', sessionId: value.sessionId, title: value.title }
  if (name === 'session.configuration' && typeof value.sessionId === 'string' && isRecord(value.patch))
    return {
      type: 'session.configuration',
      sessionId: value.sessionId,
      patch: configurationPatch(value.patch),
    }
  if (name === 'session.added' && typeof value.sessionId === 'string')
    return {
      type: 'session.added',
      sessionId: value.sessionId,
      ...(typeof value.blank === 'boolean' ? { blank: value.blank } : {}),
      ...(typeof value.parentSessionId === 'string' ? { parentSessionId: value.parentSessionId } : {}),
      ...(value.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
      ...(typeof value.cwd === 'string' && value.cwd.trim() !== '' ? { cwd: value.cwd } : {}),
      ...(typeof value.agentPreset === 'string' && value.agentPreset.trim() !== ''
        ? { agentPreset: value.agentPreset }
        : {}),
    }
  if (name === 'session.removed' && typeof value.sessionId === 'string')
    return { type: 'session.removed', sessionId: value.sessionId }
  if (name === 'session.projection' && typeof value.sessionId === 'string' && typeof value.key === 'string')
    return { type: 'session.projection', sessionId: value.sessionId, key: value.key, value: value.value }
  if (
    name === 'tool.updated' &&
    typeof value.sessionId === 'string' &&
    isRecord(value.tool) &&
    typeof value.tool.id === 'string' &&
    typeof value.tool.name === 'string' &&
    isToolStatus(value.tool.status)
  ) {
    const turn = finiteEventIndex(value.tool.turn)
    const step = finiteEventIndex(value.tool.step)
    const locations = parseToolLocations(value.tool.locations)
    const presentation = parseToolPresentation(value.tool.presentation)
    return {
      type: 'tool.updated',
      sessionId: value.sessionId,
      tool: {
        id: value.tool.id,
        ...(turn === undefined ? {} : { turn }),
        ...(step === undefined ? {} : { step }),
        name: value.tool.name,
        category: typeof value.tool.category === 'string' ? value.tool.category : 'tool',
        title: typeof value.tool.title === 'string' ? value.tool.title : value.tool.name,
        status: value.tool.status,
        ...(typeof value.tool.startedAt === 'string' ? { startedAt: value.tool.startedAt } : {}),
        ...(typeof value.tool.completedAt === 'string' ? { completedAt: value.tool.completedAt } : {}),
        ...(typeof value.tool.inputSummary === 'string' ? { inputSummary: value.tool.inputSummary } : {}),
        ...(typeof value.tool.outputSummary === 'string' ? { outputSummary: value.tool.outputSummary } : {}),
        ...(typeof value.tool.error === 'string' ? { error: value.tool.error } : {}),
        ...(locations === undefined ? {} : { locations }),
        ...(presentation === undefined ? {} : { presentation }),
        metadata: isRecord(value.tool.metadata) ? value.tool.metadata : {},
      },
    }
  }
  if (name === 'team.updated' && typeof value.sessionId === 'string') {
    const activity = parseTeamActivity(value.activity)
    return activity === undefined
      ? { type: 'unknown', sessionId: value.sessionId, name, payload }
      : { type: 'team.updated', sessionId: value.sessionId, activity }
  }
  if (name === 'goal.updated' && typeof value.sessionId === 'string' && Array.isArray(value.goals)) {
    const goals = value.goals.flatMap((entry) => {
      const goal = object(entry)
      if (
        goal === undefined ||
        typeof goal.id !== 'string' ||
        typeof goal.title !== 'string' ||
        !isGoalStatus(goal.status)
      )
        return []
      return [{ id: goal.id, title: goal.title, status: goal.status }]
    })
    return { type: 'goal.updated', sessionId: value.sessionId, goals }
  }
  if (name === 'todo.updated' && typeof value.sessionId === 'string' && Array.isArray(value.todos)) {
    return {
      type: 'todo.updated',
      sessionId: value.sessionId,
      todos: value.todos.flatMap((entry, index) => {
        const todo = object(entry)
        if (todo === undefined || typeof todo.content !== 'string') return []
        const status = todo.status
        return [
          {
            id: typeof todo.id === 'string' ? todo.id : `todo:${index}`,
            content: todo.content,
            status:
              status === 'completed' ? 'completed' : status === 'in-progress' ? 'in-progress' : 'pending',
          },
        ]
      }),
    }
  }
  if (
    name === 'compaction.updated' &&
    typeof value.sessionId === 'string' &&
    isRecord(value.compaction) &&
    typeof value.compaction.id === 'string'
  ) {
    const phase = value.compaction.phase
    if (phase === 'start' || phase === 'summary' || phase === 'prune' || phase === 'end')
      return {
        type: 'compaction.updated',
        sessionId: value.sessionId,
        compaction: {
          id: value.compaction.id,
          phase,
          ...(typeof value.compaction.summary === 'string' ? { summary: value.compaction.summary } : {}),
          ...(typeof value.compaction.replacedCount === 'number'
            ? { replacedCount: value.compaction.replacedCount }
            : {}),
          ...(typeof value.compaction.estimatedTokens === 'number'
            ? { estimatedTokens: value.compaction.estimatedTokens }
            : {}),
        },
      }
  }
  if (name === 'model.retry' && isRecord(value.retry)) {
    const retry = value.retry
    if (
      typeof retry.sessionId === 'string' &&
      typeof retry.id === 'string' &&
      typeof retry.turn === 'number' &&
      typeof retry.step === 'number' &&
      typeof retry.attempt === 'number' &&
      (retry.state === 'scheduled' || retry.state === 'started')
    )
      return {
        type: 'model.retry',
        retry: {
          sessionId: retry.sessionId,
          id: retry.id,
          turn: retry.turn,
          step: retry.step,
          attempt: retry.attempt,
          state: retry.state,
          ...(typeof retry.delayMs === 'number' ? { delayMs: retry.delayMs } : {}),
          ...(typeof retry.maxRetries === 'number' ? { maxRetries: retry.maxRetries } : {}),
          ...(typeof retry.message === 'string' ? { message: retry.message } : {}),
        },
      }
  }
  if (
    name === 'jobs.updated' &&
    typeof value.sessionId === 'string' &&
    Array.isArray(value.jobs) &&
    value.jobs.every(isJobView)
  ) {
    return {
      type: 'jobs.updated',
      sessionId: value.sessionId,
      jobs: value.jobs,
    }
  }
  if (name === 'queue.updated' && typeof value.sessionId === 'string' && Array.isArray(value.items)) {
    return {
      type: 'queue.updated',
      sessionId: value.sessionId,
      items: value.items.flatMap((entry) => (isQueuedInput(entry) ? [entry] : [])),
    }
  }
  if (name === 'workflow.started' && typeof value.sessionId === 'string' && isWorkflowSummary(value.workflow))
    return {
      type: 'workflow.started',
      sessionId: value.sessionId,
      workflow: value.workflow,
    }
  if (
    name === 'workflow.member.started' &&
    typeof value.sessionId === 'string' &&
    typeof value.runId === 'string' &&
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
    typeof value.sessionId === 'string' &&
    typeof value.runId === 'string' &&
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
    typeof value.sessionId === 'string' &&
    typeof value.runId === 'string' &&
    (value.stopReason === 'completed' || value.stopReason === 'cancelled' || value.stopReason === 'error')
  )
    return {
      type: 'workflow.ended',
      sessionId: value.sessionId,
      runId: value.runId,
      stopReason: value.stopReason,
    }
  if (name === 'permission.requested' && isRecord(value.request)) {
    const request = value.request
    if (
      typeof request.id === 'string' &&
      typeof request.sessionId === 'string' &&
      typeof request.title === 'string' &&
      typeof request.description === 'string' &&
      (request.risk === 'low' || request.risk === 'medium' || request.risk === 'high') &&
      Array.isArray(request.options)
    )
      return {
        type: 'permission.requested',
        request: {
          id: request.id,
          ...(typeof request.rpcId === 'string' ? { rpcId: request.rpcId } : {}),
          sessionId: request.sessionId,
          title: request.title,
          description: request.description,
          risk: request.risk,
          options: request.options.flatMap((entry) => {
            const option = object(entry)
            if (
              option === undefined ||
              typeof option.id !== 'string' ||
              typeof option.label !== 'string' ||
              !isPermissionKind(option.kind)
            )
              return []
            return [{ id: option.id, label: option.label, kind: option.kind }]
          }),
        },
      }
  }
  if (name === 'question.requested' && isRecord(value.question)) {
    const question = value.question
    if (
      typeof question.id === 'string' &&
      typeof question.sessionId === 'string' &&
      typeof question.prompt === 'string' &&
      typeof question.allowFreeText === 'boolean'
    )
      return {
        type: 'question.requested',
        question: {
          id: question.id,
          ...(typeof question.rpcId === 'string' ? { rpcId: question.rpcId } : {}),
          sessionId: question.sessionId,
          prompt: question.prompt,
          ...(typeof question.detail === 'string' ? { detail: question.detail } : {}),
          ...(typeof question.header === 'string' ? { header: question.header } : {}),
          ...(Array.isArray(question.choices) ? { choices: questionChoices(question.choices) } : {}),
          ...(typeof question.multiSelect === 'boolean' ? { multiSelect: question.multiSelect } : {}),
          allowFreeText: question.allowFreeText,
          ...questionIntent(question.intent),
          ...(Array.isArray(question.items)
            ? {
                items: question.items.flatMap((entry) => {
                  const item = object(entry)
                  if (
                    item === undefined ||
                    typeof item.id !== 'string' ||
                    typeof item.prompt !== 'string' ||
                    typeof item.allowFreeText !== 'boolean'
                  )
                    return []
                  const intent = questionIntent(item.intent)
                  return [
                    {
                      id: item.id,
                      prompt: item.prompt,
                      ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
                      ...(typeof item.header === 'string' ? { header: item.header } : {}),
                      ...(Array.isArray(item.choices) ? { choices: questionChoices(item.choices) } : {}),
                      ...(typeof item.multiSelect === 'boolean' ? { multiSelect: item.multiSelect } : {}),
                      allowFreeText: item.allowFreeText,
                      ...(intent === undefined ? {} : { intent }),
                    },
                  ]
                }),
              }
            : {}),
        },
      }
  }
  if (name === 'workspace.changed' && typeof value.workspaceId === 'string')
    return { type: 'workspace.changed', workspaceId: value.workspaceId }
  if (name === 'workspace.changed') return { type: 'workspace.changed' }
  if (name === 'workspace.removed' && typeof value.workspaceId === 'string')
    return { type: 'workspace.removed', workspaceId: value.workspaceId }
  if (name === 'workspace.removed') return { type: 'workspace.removed' }
  if (name === 'workspace.order.changed' && Array.isArray(value.workspaceIds))
    return {
      type: 'workspace.order.changed',
      workspaceIds: value.workspaceIds.filter((entry): entry is string => typeof entry === 'string'),
    }
  if (name === 'archived.sessions.changed' && Array.isArray(value.sessionIds))
    return {
      type: 'archived.sessions.changed',
      sessionIds: value.sessionIds.filter((entry): entry is string => typeof entry === 'string'),
    }
  if (name === 'remote.event' && typeof value.name === 'string' && Array.isArray(value.args))
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
  )
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
      ...(typeof value.commandInput === 'string' && value.commandInput.trim() !== ''
        ? { commandInput: value.commandInput.slice(0, 4_096) }
        : {}),
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

function parseSessionHistory(value: unknown): readonly SessionHistoryEvent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry, index): SessionHistoryEvent[] => {
    const record = object(entry)
    const eventRecord = object(record?.event) ?? record
    if (eventRecord === undefined || typeof eventRecord.type !== 'string') return []
    const event = domainEvent(eventRecord.type, eventRecord)
    if (event === undefined) return []
    const sequence = finiteSequence(record?.sequence ?? eventRecord.sequence, index)
    return [
      {
        sequence,
        time: typeof record?.time === 'string' ? record.time : historyTime(event),
        event: { ...event, sequence },
      },
    ]
  })
}

function parseSessionHistoryPage(value: unknown): {
  readonly events: readonly SessionHistoryEvent[]
  readonly hasMore: boolean
  readonly beforeSequence?: number
  readonly projection?: SessionProjectionSnapshot
} {
  const page = object(value)
  if (page === undefined || !Array.isArray(page.events) || typeof page.hasMore !== 'boolean')
    throw new Error(translate('app.error.malformedHistory'))
  const events = parseSessionHistory(page.events)
  const beforeSequence = optionalSequence(page.beforeSeq) ?? oldestHistorySequence(events)
  const projection = parseSessionProjection(page.projection)
  return {
    events,
    hasMore: page.hasMore,
    ...(beforeSequence === undefined ? {} : { beforeSequence }),
    ...(projection === undefined ? {} : { projection }),
  }
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
  const bySequence = new Map<number, SessionHistoryEvent>()
  for (const entry of [...current, ...additions]) {
    if (!bySequence.has(entry.sequence)) bySequence.set(entry.sequence, entry)
  }
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence)
}

function oldestHistorySequence(history: readonly SessionHistoryEvent[]): number | undefined {
  return history.reduce<number | undefined>(
    (oldest, entry) => (oldest === undefined ? entry.sequence : Math.min(oldest, entry.sequence)),
    undefined,
  )
}

function newestHistorySequence(history: readonly SessionHistoryEvent[]): number | undefined {
  return history.reduce<number | undefined>(
    (newest, entry) => (newest === undefined ? entry.sequence : Math.max(newest, entry.sequence)),
    undefined,
  )
}

function optionalSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function historyTime(event: BackendEvent): string {
  const value = 'time' in event ? event.time : undefined
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : new Date().toISOString()
}

function hydrateTimeline(sessionId: string, history: readonly unknown[]): TimelineState {
  const valid: Array<{ readonly event: BackendEvent; readonly sequence: number }> = history.flatMap(
    (entry, index) => {
      const record = object(entry)
      if (record === undefined)
        return [
          {
            event: { type: 'unknown', name: 'history/invalid-entry', payload: { index } },
            sequence: index,
          },
        ]
      if (typeof record.event !== 'object' || record.event === null)
        return [
          {
            event: { type: 'unknown', name: 'history/missing-event', payload: { index } },
            sequence: finiteSequence(record.sequence, index),
          },
        ]
      const eventRecord = object(record.event)
      if (eventRecord === undefined || typeof eventRecord.type !== 'string')
        return [
          {
            event: { type: 'unknown', name: 'history/invalid-event', payload: { index } },
            sequence: finiteSequence(record.sequence, index),
          },
        ]
      const event = domainEvent(eventRecord.type, eventRecord)
      if (event === undefined)
        return [
          {
            event: { type: 'unknown', name: eventRecord.type, payload: { index } },
            sequence: finiteSequence(record.sequence, index),
          },
        ]
      const sequence = finiteSequence(record.sequence ?? eventRecord.sequence ?? eventRecord.seq, index)
      return [{ event, sequence }]
    },
  )
  let timeline: TimelineState = {
    sessionId,
    nodes: [],
    lastSequence: valid.length === 0 ? -1 : Number.MIN_SAFE_INTEGER,
  }
  valid.sort((left, right) => left.sequence - right.sequence)
  valid.forEach(({ event, sequence }) => {
    timeline = reduceTimeline(timeline, {
      sequence,
      event,
      // Projection/lifecycle records carry durable sequence metadata but are
      // not conversation records. Keep their state updates while preventing
      // them from consuming the timeline cursor during history rehydration.
      ...(!advancesTimelineSequence(event) ? { advanceSequence: false } : {}),
    })
  })
  const lastSequence = valid.reduce(
    (maximum, entry) => (advancesTimelineSequence(entry.event) ? Math.max(maximum, entry.sequence) : maximum),
    -1,
  )
  return valid.length === 0 ? timeline : { ...timeline, lastSequence }
}

function finiteSequence(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
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

function parseTokenUsage(value: unknown): TokenUsage | undefined {
  const record = object(value)
  if (record === undefined) return undefined
  const inputTokens = tokenCount(record.inputTokens ?? record.uncachedInputTokens)
  const outputTokens = tokenCount(record.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const cacheReadTokens = tokenCount(record.cacheReadTokens)
  const cacheWriteTokens = tokenCount(record.cacheWriteTokens)
  const reasoningTokens = tokenCount(record.reasoningTokens)
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
  const attachments = value.slice(0, 32).flatMap((entry): MessageAttachment[] => {
    const record = object(entry)
    if (record === undefined || typeof record.name !== 'string' || record.name.trim() === '') return []
    return [
      {
        name: record.name,
        ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
      },
    ]
  })
  return attachments.length === 0 ? undefined : attachments
}

function messageImages(value: unknown): readonly MessageImageReference[] | undefined {
  if (!Array.isArray(value)) return undefined
  const images = value.slice(0, 32).flatMap((entry): MessageImageReference[] => {
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
      height === undefined
    )
      return []
    return [
      {
        attachmentId,
        mediaType,
        bytes,
        width,
        height,
        ...(typeof record?.name === 'string' && record.name.trim() !== '' ? { name: record.name } : {}),
      },
    ]
  })
  const unique: MessageImageReference[] = []
  const seen = new Set<string>()
  for (const image of images) {
    if (seen.has(image.attachmentId)) continue
    seen.add(image.attachmentId)
    unique.push(image)
  }
  return unique.length === 0 ? undefined : unique
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
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
      const cwd = presentationPath(view.cwd)
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
    const line = positivePresentationNumber(record?.line)
    locations.push({ path, ...(line === undefined ? {} : { line }) })
  }
  return locations.length === 0 ? undefined : locations
}

function parseToolDiffs(value: unknown): readonly ToolPresentationDiff[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 32).flatMap((entry): ToolPresentationDiff[] => {
    const diff = object(entry)
    const path = presentationPath(diff?.path)
    const newText = presentationText(diff?.newText)
    const oldText = diff?.oldText === null ? null : presentationText(diff?.oldText)
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
  const files = value.files.slice(0, 128).flatMap((entry): ToolPresentationSearchFile[] => {
    const file = object(entry)
    const path = presentationPath(file?.path)
    if (file === undefined || path === undefined || !Array.isArray(file.matches)) return []
    const matches = file.matches.slice(0, 128).flatMap((matchValue): ToolPresentationSearchMatch[] => {
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
  const lines = value.lines.slice(0, 512).flatMap((entry): ToolPresentationLine[] => {
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

function presentationText(value: unknown, allowEmpty = false): string | undefined {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) return undefined
  return value.slice(0, 4_096)
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

function questionChoices(entries: readonly unknown[]): {
  id: string
  label: string
  description?: string
}[] {
  return entries.flatMap((entry) => {
    const choice = object(entry)
    return choice !== undefined && typeof choice.id === 'string' && typeof choice.label === 'string'
      ? [
          {
            id: choice.id,
            label: choice.label,
            ...(typeof choice.description === 'string' ? { description: choice.description } : {}),
          },
        ]
      : []
  })
}

/** Upstream intents are tagged; unknown tags render the generic option flow. */
function questionIntent(value: unknown): UserQuestion['intent'] | undefined {
  const intent = object(value)
  if (intent === undefined) return undefined
  if (intent.kind !== 'plan-review' || typeof intent.approve !== 'string') return undefined
  return { kind: 'plan-review', approve: intent.approve }
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
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    typeof item.blank === 'boolean' &&
    typeof item.status === 'string'
  )
}

function isWorkspaceSummary(value: unknown): value is WorkspaceSummary {
  const item = object(value)
  return item !== undefined && typeof item.id === 'string' && typeof item.name === 'string'
}

function isModelProvider(value: unknown): value is ModelProvider {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.kind === 'string' &&
    typeof item.configurable === 'boolean' &&
    Array.isArray(item.fields)
  )
}

function isModelDescriptor(value: unknown): value is ModelDescriptor {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    typeof item.providerId === 'string' &&
    typeof item.label === 'string' &&
    typeof item.supportsReasoning === 'boolean'
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
  return rows.length > 512 ? undefined : rows.filter(isDiscoveredModel)
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
  return {
    version: 1,
    composerPreferences: {
      ...(preset === undefined ? {} : { preset }),
      ...(model === undefined ? {} : { model }),
      ...(openFileId === undefined ? {} : { openFileId }),
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
    return { ...configuration, permissionPreset: parts[1] }
  if (parts[0] === 'plan') return { ...configuration, planMode: parts[1] !== 'off' }
  return configuration
}

function isToolMode(value: unknown): value is AgentConfiguration['toolMode'] {
  return value === 'native' || value === 'code' || value === 'both'
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
    typeof item.isDefault === 'boolean'
  )
}

/** Parse the `agentPreset.list` answer: roster rows plus the deployment facts. */
function parsePresetRoster(value: unknown): AgentPresetRoster | undefined {
  const roster = object(value)
  if (roster === undefined || !Array.isArray(roster.presets)) return undefined
  return {
    presets: roster.presets.filter(isPresetDescriptor),
    authorable: roster.authorable === true,
    hasDocument: roster.hasDocument === true,
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
    typeof item.enabled === 'boolean' &&
    (item.fiberPhase === null ||
      (typeof item.fiberPhase === 'string' && FIBER_PHASES.includes(item.fiberPhase)))
  )
}

/** Parse the `pluginInventory/list` projection; malformed rows are dropped. */
function parsePluginInventory(value: unknown): PluginInventorySnapshot | undefined {
  const snapshot = object(value)
  if (snapshot === undefined || !Array.isArray(snapshot.entries)) return undefined
  return { entries: snapshot.entries.filter(isPluginInventoryEntry) }
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function isDynamicCommand(value: unknown): value is DynamicCommand {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.name === 'string' &&
    typeof item.description === 'string' &&
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
    typeof item.name === 'string' &&
    typeof item.description === 'string' &&
    (item.source === 'project' || item.source === 'user' || item.source === 'plugin') &&
    typeof item.enabled === 'boolean'
  )
}

function isGoalView(value: unknown): value is GoalView {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    isGoalStatus(item.status)
  )
}

function isJobView(value: unknown): value is JobView {
  const item = object(value)
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
    (item.finishedAt === undefined ||
      (Number.isSafeInteger(item.finishedAt) && (item.finishedAt as number) >= 0))
  )
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
    (item.createdAt === undefined ||
      (typeof item.createdAt === 'number' && Number.isSafeInteger(item.createdAt) && item.createdAt >= 0)) &&
    (item.updatedAt === undefined ||
      (typeof item.updatedAt === 'number' && Number.isSafeInteger(item.updatedAt) && item.updatedAt >= 0))
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
    typeof item.sessionId === 'string' &&
    typeof item.text === 'string' &&
    Array.isArray(item.attachments) &&
    (item.mode === 'queue' || item.mode === 'steer') &&
    typeof item.createdAt === 'string'
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
