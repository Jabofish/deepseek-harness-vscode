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
  type DynamicCommand,
  type ExtensionSettingsSummary,
  type GoalView,
  type JobView,
  type MessageAttachment,
  type ModelDescriptor,
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
  type SessionSummary,
  type SubagentCatalog,
  type SubagentHistoryPage,
  type SubagentView,
  type TokenUsage,
  type TodoView,
  type UserQuestion,
  type WorkflowMember,
  type WorkflowSummary,
  type WorkspaceSummary,
} from '@dsh-vscode/domain'
import { isInjectedUserMessage, reduceTimeline, type TimelineState } from '@dsh-vscode/timeline'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'

import { ProtocolClient } from './protocol-client.js'
import { getVsCodeApi } from '../vscode-api.js'

export interface OpenFileCandidate {
  readonly id: string
  readonly name: string
  readonly mimeType?: string
  readonly active: boolean
  readonly supported: boolean
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
  readonly sessions: readonly SessionSummary[]
  readonly archivedSessionIds: readonly string[]
  readonly workspaces: readonly WorkspaceSummary[]
  readonly activeSessionId: string | undefined
  readonly preferredOpenFileId: string | undefined
  readonly timeline: TimelineState
  readonly projections: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly configuration: AgentConfiguration | undefined
  readonly providers: readonly ModelProvider[]
  readonly models: readonly ModelDescriptor[]
  readonly presets: readonly AgentPresetDescriptor[]
  readonly permissionPresets: readonly string[]
  readonly commands: readonly DynamicCommand[]
  readonly goals: readonly GoalView[]
  readonly todos: readonly TodoView[]
  readonly jobs: readonly JobView[]
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
  openSubagent(entry: SubagentView, parentAvailable: boolean): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>
  createSession(workspaceId?: string): Promise<void>
  removeSession(sessionId: string): Promise<void>
  configureSession(sessionId: string, configuration: AgentConfiguration): Promise<void>
  executeCommand(sessionId: string, command: string): Promise<void>
  sendPrompt(
    sessionId: string,
    text: string,
    attachments: readonly PromptAttachment[],
    mode: RunningInputMode,
  ): Promise<void>
  cancelSession(sessionId: string): Promise<void>
  updateQueue(inputId: string, text: string): Promise<void>
  removeQueue(inputId: string): Promise<void>
  steerQueue(inputId: string): Promise<void>
  /** Steer every still-queued pending input into the running turn (official empty-draft accelerated Enter). */
  steerAllQueued(): Promise<void>
  respondToPermission(interactionId: string, optionId: string): Promise<void>
  respondToQuestion(
    questionId: string,
    response: string | readonly string[] | readonly QuestionAnswer[],
  ): Promise<void>
  cancelQuestion(questionId: string): Promise<void>
  pickAttachment(): Promise<PromptAttachment | undefined>
  ingestAttachment(input: IngestedFile): Promise<PromptAttachment | undefined>
  previewAttachment(uri: string): Promise<string | undefined>
  releaseAttachments(uris: readonly string[]): Promise<void>
  listOpenFiles(): Promise<readonly OpenFileCandidate[]>
  attachOpenFile(candidateId: string): Promise<PromptAttachment | undefined>
  rememberOpenFile(candidateId: string): void
  openLink(href: string): Promise<void>
  runtimeAction(action: 'install' | 'select' | 'copy-command' | 'open-docs'): Promise<void>
  readSettings(): Promise<ExtensionSettingsSummary | undefined>
  readDshSettings(): Promise<DshSettingsSnapshot | undefined>
  updateDshSetting(path: string, value: unknown): Promise<void>
  configureProviderSecret(providerId: string, field: string): Promise<boolean>
  removeProviderSecret(providerId: string, field: string): Promise<void>
  refreshModelCatalog(): Promise<void>
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
    sessions: [],
    archivedSessionIds: [],
    workspaces: [],
    activeSessionId: undefined,
    preferredOpenFileId: composerPreferences.openFileId,
    timeline: { sessionId: undefined, nodes: [], lastSequence: -1 },
    projections: {},
    configuration: undefined,
    providers: [],
    models: [],
    presets: [],
    permissionPresets: [],
    commands: [],
    goals: [],
    todos: [],
    jobs: [],
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
  const executeCommandRequest = async (sessionId: string, command: string): Promise<void> => {
    await client.request<unknown>({
      type: 'command.execute',
      requestId: requestId(),
      payload: { sessionId, command },
    })
    setState((current) => {
      if (current.activeSessionId !== sessionId || current.configuration === undefined) return current
      return { ...current, configuration: applyKnownCommand(current.configuration, command) }
    })
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
      const permissionPresets = stringList(detail?.permissionPresets)
      const [queue, goals, jobs, subagents, commands] = await Promise.all([
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
        loadSubagentCatalog(sessionId),
        loadCommandDirectory(sessionId),
      ])
      if (version !== openVersion) return
      setState((current) =>
        replayHostMessages(
          {
            ...current,
            activeSessionId: sessionId,
            timeline,
            projections: setSessionProjection(current.projections, sessionId, detail?.projection),
            sessions: upsertOpenedSession(current.sessions, detail, sessionId),
            configuration: isAgentConfiguration(detail?.configuration)
              ? detail.configuration
              : createDefaultConfiguration(current, composerPreferences),
            permissionPresets: permissionPresets ?? [],
            queue,
            goals,
            todos: latestTodos(timeline),
            jobs,
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
      const [history, queue, goals, jobs, subagents] = await Promise.all([
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
            projections: setSessionProjection(current.projections, entry.id, history.projection),
            configuration: undefined,
            permissionPresets: [],
            queue,
            goals,
            todos: latestTodos(timeline),
            jobs,
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
  return {
    get backend() {
      return state.backend
    },
    get connectedDshVersion() {
      return state.connectedDshVersion
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
      await client.request<unknown>({ type: 'app.ready', requestId: requestId() })
      await refresh()
      // Official ui-conversation row: the host-side busy-Enter preference is
      // the composer's plain-Enter policy while a turn is running. A failed
      // read keeps the official default ('queue').
      await applyBusyEnterPreference()
      const rememberedSessionId = persistedWebviewState.activeSessionId
      if (
        rememberedSessionId !== undefined &&
        state.sessions.some((session) => session.id === rememberedSessionId)
      )
        await open(rememberedSessionId)
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
    openSubagent,
    renameSession: async (sessionId, title) => {
      await client.request<unknown>({
        type: 'session.rename',
        requestId: requestId(),
        payload: { sessionId, title },
      })
      setState((current) => ({
        ...current,
        sessions: current.sessions.map((session) =>
          session.id === sessionId ? { ...session, title } : session,
        ),
      }))
    },
    configureSession: async (sessionId, configuration) => {
      await client.request<unknown>({
        type: 'session.configure',
        requestId: requestId(),
        payload: { sessionId, configuration },
      })
      rememberComposerConfiguration(configuration)
      setState((current) => (current.activeSessionId === sessionId ? { ...current, configuration } : current))
    },
    executeCommand: executeCommandRequest,
    createSession: async (workspaceId) => {
      const workspace =
        (workspaceId === undefined
          ? undefined
          : state.workspaces.find((entry) => entry.id === workspaceId)) ?? state.workspaces[0]
      const configuration = createDefaultConfiguration(state, composerPreferences)
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
              projections: removeSessionProjection(current.projections, sessionId),
              configuration: undefined,
              permissionPresets: [],
              queue: [],
              goals: [],
              todos: [],
              jobs: [],
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
        if (subagent.entry.mode === 'one-shot')
          throw new Error('One-shot subagent conversations are read-only.')
        if (!subagent.parentAvailable)
          throw new Error('The parent session is unavailable for a subagent follow-up.')
        if (attachments.length > 0)
          throw new Error('Attachments are unavailable for subagent follow-up messages.')
        if (text.trim() === '') throw new Error('A subagent follow-up message is required.')
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
      if (subagent?.entry.mode === 'one-shot')
        throw new Error('One-shot subagent conversations cannot be interrupted.')
      await client.request<unknown>(
        subagent === undefined
          ? { type: 'session.cancel', requestId: requestId(), payload: { sessionId } }
          : { type: 'subagent.interrupt', requestId: requestId(), payload: { sessionId } },
      )
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
      throw new Error(
        typeof result?.message === 'string' ? result.message : 'The linked file could not be opened.',
      )
    },
    runtimeAction: (action) =>
      client
        .request<unknown>({ type: 'runtime.action', requestId: requestId(), payload: { action } })
        .then(() => undefined),
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
    updateDshSetting: async (path, value) => {
      await client.request<unknown>({
        type: 'settings.update',
        requestId: requestId(),
        payload: { path, value },
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
      setState((current) => ({ ...current, drawer }))
      persistWebviewState()
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
    (connection.mode !== 'auto' && connection.mode !== 'attach-only' && connection.mode !== 'new-isolated') ||
    typeof runtime.customExecutableConfigured !== 'boolean' ||
    typeof runtime.autoStart !== 'boolean' ||
    !isPermissionPreset(security.defaultPermissionPreset) ||
    !isAgentConfiguration(defaultAgent)
  )
    return undefined
  return {
    connection: { mode: connection.mode },
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
            projections: {},
            configuration: undefined,
            permissionPresets: [],
            queue: [],
            goals: [],
            todos: [],
            jobs: [],
            subagents: EMPTY_SUBAGENT_CATALOG,
            activeSubagent: undefined,
            commands: [],
          }
        : {}),
    }
  })
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

function parseSubagentCatalog(value: unknown): SubagentCatalog {
  const catalog = object(value)
  if (
    catalog === undefined ||
    !Array.isArray(catalog.entries) ||
    !catalog.entries.every(isSubagentCatalogEntry) ||
    typeof catalog.parentAvailable !== 'boolean'
  )
    throw new Error('DSH returned a malformed subagent catalog.')
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
    throw new Error('DSH returned a malformed subagent history page.')
  const projection = object(page.projection)
  if (
    page.projection !== undefined &&
    (projection === undefined ||
      !Number.isSafeInteger(projection.asOfSequence) ||
      (projection.asOfSequence as number) < -1 ||
      object(projection.values) === undefined)
  )
    throw new Error('DSH returned a malformed subagent projection baseline.')
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
  try {
    const result = await client.request<unknown>({
      type: 'command.list',
      requestId: requestId(),
      payload: { sessionId },
    })
    return withClientCommandContributions(listValues(result).filter(isDynamicCommand))
  } catch {
    // A registry refresh is advisory. Keep the last known directory when a
    // transient connection failure occurs during commands/change handling.
    return undefined
  }
}

function withClientCommandContributions(commands: readonly DynamicCommand[]): readonly DynamicCommand[] {
  if (commands.some((command) => command.name === 'model')) return commands
  return [
    ...commands,
    {
      name: 'model',
      description: 'Select the model for this conversation',
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
      setState({ ...state, backend: { kind, searchedLocations }, connectedDshVersion: undefined })
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
          backend: {
            kind,
            message: typeof snapshot?.message === 'string' ? snapshot.message : 'Connection failed.',
            retryable: snapshot?.retryable === true,
          },
        })
      else if (kind === 'port-conflict')
        setState({
          ...state,
          connectedDshVersion: undefined,
          backend: {
            kind,
            port: typeof snapshot?.port === 'number' ? snapshot.port : 0,
            message: typeof snapshot?.message === 'string' ? snapshot.message : 'Port conflict.',
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
        })
    }
    return
  }
  const event = domainEvent(message.name, message.payload)
  if (event === undefined) return
  const eventSessionId = backendEventSessionId(event)
  const belongsToActiveSession = eventSessionId === undefined || eventSessionId === state.activeSessionId
  const controlPlaneMessage = event.type === 'message.user' && isCommandMessageSource(event.source)
  // Command records are control-plane history and stay out of both Chat and
  // Trajectory.  Other producer-owned user/message records are retained as
  // context nodes; Chat filters those nodes while Trajectory exposes their
  // provenance, matching the upstream target-specific projections.
  const timeline = !belongsToActiveSession
    ? state.timeline
    : controlPlaneMessage
      ? { ...state.timeline, lastSequence: message.sequence }
      : reduceTimeline(state.timeline, { sequence: message.sequence, event })
  let next = { ...state, timeline }
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
            projections: removeSessionProjection(next.projections, event.sessionId),
            configuration: undefined,
            permissionPresets: [],
            queue: [],
            goals: [],
            todos: [],
            jobs: [],
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
      queue: [],
      jobs: [],
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
  const value = object(payload)
  if (value === undefined) return { type: 'unknown', name, payload }
  if (
    name === 'message.user' &&
    typeof value.sessionId === 'string' &&
    typeof value.messageId === 'string' &&
    typeof value.markdown === 'string'
  ) {
    const attachments = messageAttachments(value.attachments)
    return {
      type: 'message.user',
      sessionId: value.sessionId,
      messageId: value.messageId,
      markdown: value.markdown,
      ...(attachments === undefined ? {} : { attachments }),
      ...(typeof value.rpcId === 'string' ? { rpcId: value.rpcId } : {}),
      ...(typeof value.source === 'string' ? { source: value.source } : {}),
      ...(typeof value.sourceForm === 'string' ? { sourceForm: value.sourceForm } : {}),
      ...(typeof value.sourceSummary === 'string' ? { sourceSummary: value.sourceSummary } : {}),
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
  )
    return {
      type: 'tool.updated',
      sessionId: value.sessionId,
      tool: {
        id: value.tool.id,
        name: value.tool.name,
        category: typeof value.tool.category === 'string' ? value.tool.category : 'tool',
        title: typeof value.tool.title === 'string' ? value.tool.title : value.tool.name,
        status: value.tool.status,
        ...(typeof value.tool.startedAt === 'string' ? { startedAt: value.tool.startedAt } : {}),
        ...(typeof value.tool.completedAt === 'string' ? { completedAt: value.tool.completedAt } : {}),
        ...(typeof value.tool.inputSummary === 'string' ? { inputSummary: value.tool.inputSummary } : {}),
        ...(typeof value.tool.outputSummary === 'string' ? { outputSummary: value.tool.outputSummary } : {}),
        ...(typeof value.tool.error === 'string' ? { error: value.tool.error } : {}),
        metadata: isRecord(value.tool.metadata) ? value.tool.metadata : {},
      },
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
  valid.forEach(({ event, sequence }) => {
    timeline = reduceTimeline(timeline, { sequence, event })
  })
  const lastSequence = valid.reduce((maximum, entry) => Math.max(maximum, entry.sequence), -1)
  return valid.length === 0 ? timeline : { ...timeline, lastSequence }
}

function finiteSequence(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
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
    (item.input === undefined || (isRecord(item.input) && typeof item.input.hint === 'string')) &&
    (item.source === undefined ||
      item.source === 'builtin' ||
      item.source === 'skill' ||
      item.source === 'plugin')
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

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
