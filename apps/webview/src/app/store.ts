import {
  parseSlashCommand,
  type AgentConfiguration,
  type AgentPresetDescriptor,
  type BackendEvent,
  type BackendState,
  type DynamicCommand,
  type GoalView,
  type JobView,
  type ModelDescriptor,
  type ModelProvider,
  type ModelSelection,
  type PermissionRequest,
  type PromptAttachment,
  type QueuedInput,
  type SessionConfigurationPatch,
  type SessionSummary,
  type SubagentView,
  type TokenUsage,
  type TodoView,
  type UserQuestion,
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

export interface AppState {
  readonly backend: BackendState
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
  readonly subagents: readonly SubagentView[]
  readonly queue: readonly QueuedInput[]
  readonly permissions: readonly PermissionRequest[]
  readonly questions: readonly UserQuestion[]
  readonly drawer: 'sessions' | 'jobs' | 'subagents' | 'settings' | undefined
}

export interface AppActions {
  initialize(): Promise<void>
  reconnect(): Promise<void>
  refreshSessions(): Promise<void>
  openSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>
  createSession(workspaceId?: string): Promise<void>
  removeSession(sessionId: string): Promise<void>
  configureSession(sessionId: string, configuration: AgentConfiguration): Promise<void>
  executeCommand(sessionId: string, command: string): Promise<void>
  sendPrompt(sessionId: string, text: string, attachments: readonly PromptAttachment[]): Promise<void>
  cancelSession(sessionId: string): Promise<void>
  updateQueue(inputId: string, text: string): Promise<void>
  removeQueue(inputId: string): Promise<void>
  steerQueue(inputId: string): Promise<void>
  respondToPermission(interactionId: string, optionId: string): Promise<void>
  respondToQuestion(questionId: string, response: string | readonly string[]): Promise<void>
  pickAttachment(): Promise<PromptAttachment | undefined>
  listOpenFiles(): Promise<readonly OpenFileCandidate[]>
  attachOpenFile(candidateId: string): Promise<PromptAttachment | undefined>
  rememberOpenFile(candidateId: string): void
  openLink(href: string): Promise<void>
  runtimeAction(action: 'install' | 'select' | 'copy-command' | 'open-docs'): Promise<void>
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

export function createAppStore(client = new ProtocolClient(getVsCodeApi())): AppStore {
  const vscodeApi = getVsCodeApi()
  let persistedWebviewState = readPersistedWebviewState(vscodeApi.getState())
  let composerPreferences = persistedWebviewState.composerPreferences ?? {}
  let state: AppState = {
    backend: { kind: 'idle' },
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
    subagents: [],
    queue: [],
    permissions: [],
    questions: [],
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
  let commandRefreshVersion = 0
  const refreshCommands = async (sessionId: string | undefined = state.activeSessionId): Promise<void> => {
    if (sessionId === undefined) return
    const version = ++commandRefreshVersion
    const commands = await readCommandList(client, sessionId)
    if (commands === undefined || version !== commandRefreshVersion) return
    setState((current) => (current.activeSessionId === sessionId ? { ...current, commands } : current))
  }
  const refresh = async (): Promise<void> => {
    const version = ++refreshVersion
    await refreshSessions(client, setState, () => version === refreshVersion)
    if (version === refreshVersion) await refreshCommands()
  }
  const unsubscribe = client.subscribe((message) => {
    applyHostMessage(message, state, setState)
    if (
      message.type === 'event' &&
      message.name === 'remote.event' &&
      isCommandDirectoryRefresh(message.payload)
    )
      void refreshCommands()
    if (
      message.type === 'event' &&
      message.name === 'connection.snapshot' &&
      object(message.payload)?.kind === 'connected'
    )
      void refreshCommands()
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
  })
  const open = async (sessionId: string): Promise<void> => {
    const version = ++openVersion
    commandRefreshVersion += 1
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
      safeList<SubagentView>(
        client,
        { type: 'subagent.list', requestId: requestId(), payload: { sessionId } },
        isSubagentView,
      ),
      readCommandList(client, sessionId),
    ])
    if (version !== openVersion) return
    setState((current) => ({
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
      subagents,
      commands: commands ?? (current.activeSessionId === sessionId ? current.commands : []),
    }))
    persistWebviewState({ activeSessionId: sessionId })
  }
  callbacks.openCreatedSession = open
  return {
    get backend() {
      return state.backend
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
    get queue() {
      return state.queue
    },
    get permissions() {
      return state.permissions
    },
    get questions() {
      return state.questions
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
    openSession: open,
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
    executeCommand: async (sessionId, command) => {
      await client.request<unknown>({
        type: 'command.execute',
        requestId: requestId(),
        payload: { sessionId, command },
      })
      setState((current) => {
        if (current.activeSessionId !== sessionId || current.configuration === undefined) return current
        return { ...current, configuration: applyKnownCommand(current.configuration, command) }
      })
    },
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
              subagents: [],
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
    sendPrompt: async (sessionId, text, attachments) => {
      const rpcRequestId = requestId()
      const optimisticId = `optimistic:user:${rpcRequestId}`
      const isSlashCommand = attachments.length === 0 && parseSlashCommand(text) !== undefined
      if (isSlashCommand) {
        await client.request<unknown>({
          type: 'session.sendPrompt',
          requestId: rpcRequestId,
          payload: { sessionId, text, attachments: [] },
        })
        return
      }
      const preview = text || attachments.map((attachment) => `[${attachment.name}]`).join('\n')
      if (preview !== '')
        setState((current) => {
          if (current.activeSessionId !== sessionId) return current
          return {
            ...current,
            timeline: {
              ...current.timeline,
              nodes: [
                ...current.timeline.nodes,
                { kind: 'user-message', id: optimisticId, markdown: preview },
              ],
            },
          }
        })
      try {
        await client.request<unknown>({
          type: 'session.sendPrompt',
          requestId: rpcRequestId,
          payload: { sessionId, text, attachments: [...attachments] },
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
    cancelSession: (sessionId) =>
      client
        .request<unknown>({ type: 'session.cancel', requestId: requestId(), payload: { sessionId } })
        .then(() => undefined),
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
          payload: { questionId, response: typeof response === 'string' ? response : [...response] },
        })
        .then(() =>
          setState((current) => ({
            ...current,
            questions: current.questions.filter((item) => item.id !== questionId),
          })),
        ),
    pickAttachment: async () => {
      return attachmentFromResult(
        await client.request<unknown>({ type: 'attachment.pick', requestId: requestId() }),
      )
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
      presets: listValues(value(4)).filter(isPresetDescriptor),
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
            subagents: [],
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
    return listValues(result).filter(isDynamicCommand)
  } catch {
    // A registry refresh is advisory. Keep the last known directory when a
    // transient connection failure occurs during commands/change handling.
    return undefined
  }
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
  if (message.name === 'connection.snapshot') {
    const snapshot = object(message.payload)
    const kind = snapshot?.kind
    if (kind === 'runtime-missing') {
      const searchedLocations = Array.isArray(snapshot?.searchedLocations)
        ? snapshot.searchedLocations.filter((entry): entry is string => typeof entry === 'string')
        : []
      setState({ ...state, backend: { kind, searchedLocations } })
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
          backend: {
            kind,
            message: typeof snapshot?.message === 'string' ? snapshot.message : 'Connection failed.',
            retryable: snapshot?.retryable === true,
          },
        })
      else if (kind === 'port-conflict')
        setState({
          ...state,
          backend: {
            kind,
            port: typeof snapshot?.port === 'number' ? snapshot.port : 0,
            message: typeof snapshot?.message === 'string' ? snapshot.message : 'Port conflict.',
            retryable: snapshot?.retryable === true,
          },
        })
      else setState({ ...state, backend: { kind } as BackendState })
    }
    return
  }
  const event = domainEvent(message.name, message.payload)
  if (event === undefined) return
  const controlPlaneMessage = event.type === 'message.user' && isCommandMessageSource(event.source)
  const injectedMessage = event.type === 'message.user' && isInjectedUserMessage(event)
  const timeline =
    controlPlaneMessage || injectedMessage
      ? { ...state.timeline, lastSequence: message.sequence }
      : reduceTimeline(state.timeline, { sequence: message.sequence, event })
  let next = { ...state, timeline }
  if (event.type === 'session.status') {
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
            subagents: [],
            commands: [],
          }
        : {}),
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
  } else if (event.type === 'job.updated' && event.sessionId === next.activeSessionId) {
    const jobs = [...next.jobs]
    const index = jobs.findIndex((job) => job.id === event.job.id)
    if (index < 0) jobs.push(event.job)
    else jobs[index] = event.job
    next = { ...next, jobs }
  } else if (event.type === 'subagent.updated' && event.sessionId === next.activeSessionId) {
    const subagents = [...next.subagents]
    const index = subagents.findIndex((subagent) => subagent.id === event.subagent.id)
    if (index < 0) subagents.push(event.subagent)
    else subagents[index] = event.subagent
    next = { ...next, subagents }
  } else if (event.type === 'permission.resolved') {
    next = {
      ...next,
      permissions: next.permissions.filter((request) => request.id !== event.requestId),
    }
  } else if (event.type === 'question.resolved') {
    next = {
      ...next,
      questions: next.questions.filter(
        (question) =>
          question.id !== event.questionId &&
          (event.questionRpcId === undefined || question.rpcId !== event.questionRpcId),
      ),
    }
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
    next = { ...next, backend: { kind: 'failed', message: event.reason, retryable: true }, commands: [] }
  }
  setState(next)
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
  )
    return {
      type: 'message.user',
      sessionId: value.sessionId,
      messageId: value.messageId,
      markdown: value.markdown,
      ...(typeof value.rpcId === 'string' ? { rpcId: value.rpcId } : {}),
      ...(typeof value.source === 'string' ? { source: value.source } : {}),
      ...(typeof value.sourceForm === 'string' ? { sourceForm: value.sourceForm } : {}),
      ...(typeof value.sourceSummary === 'string' ? { sourceSummary: value.sourceSummary } : {}),
    }
  if (
    name === 'message.delta' &&
    typeof value.sessionId === 'string' &&
    typeof value.messageId === 'string' &&
    typeof value.delta === 'string'
  )
    return {
      type: 'message.delta',
      sessionId: value.sessionId,
      messageId: value.messageId,
      delta: value.delta,
    }
  if (
    name === 'reasoning.delta' &&
    typeof value.sessionId === 'string' &&
    typeof value.messageId === 'string' &&
    typeof value.delta === 'string'
  )
    return {
      type: 'reasoning.delta',
      sessionId: value.sessionId,
      messageId: value.messageId,
      delta: value.delta,
    }
  if (
    name === 'message.completed' &&
    typeof value.sessionId === 'string' &&
    typeof value.messageId === 'string'
  ) {
    const usage = parseTokenUsage(value.usage)
    return {
      type: 'message.completed',
      sessionId: value.sessionId,
      messageId: value.messageId,
      ...(typeof value.markdown === 'string' ? { markdown: value.markdown } : {}),
      ...(typeof value.reasoning === 'string' ? { reasoning: value.reasoning } : {}),
      ...(typeof value.modelLabel === 'string' ? { modelLabel: value.modelLabel } : {}),
      ...(usage === undefined ? {} : { usage }),
    }
  }
  if (name === 'session.status' && typeof value.sessionId === 'string' && typeof value.status === 'string')
    return { type: 'session.status', sessionId: value.sessionId, status: value.status }
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
        },
      }
  }
  if (name === 'job.updated' && typeof value.sessionId === 'string' && isRecord(value.job)) {
    const job = value.job
    if (typeof job.id === 'string' && typeof job.label === 'string' && isJobStatus(job.status))
      return {
        type: 'job.updated',
        sessionId: value.sessionId,
        job: {
          id: job.id,
          label: job.label,
          status: job.status,
          ...(typeof job.progress === 'number' ? { progress: job.progress } : {}),
        },
      }
  }
  if (name === 'jobs.updated' && typeof value.sessionId === 'string' && Array.isArray(value.jobs)) {
    return {
      type: 'jobs.updated',
      sessionId: value.sessionId,
      jobs: value.jobs.flatMap((entry) => {
        const job = object(entry)
        if (
          job === undefined ||
          typeof job.id !== 'string' ||
          typeof job.label !== 'string' ||
          !isJobStatus(job.status)
        )
          return []
        return [
          {
            id: job.id,
            label: job.label,
            status: job.status,
            ...(typeof job.progress === 'number' ? { progress: job.progress } : {}),
          },
        ]
      }),
    }
  }
  if (name === 'queue.updated' && typeof value.sessionId === 'string' && Array.isArray(value.items)) {
    return {
      type: 'queue.updated',
      sessionId: value.sessionId,
      items: value.items.flatMap((entry) => (isQueuedInput(entry) ? [entry] : [])),
    }
  }
  if (name === 'subagent.updated' && typeof value.sessionId === 'string' && isRecord(value.subagent)) {
    const subagent = value.subagent
    if (
      typeof subagent.id === 'string' &&
      typeof subagent.label === 'string' &&
      isSubagentStatus(subagent.status) &&
      typeof subagent.parentSessionId === 'string'
    )
      return {
        type: 'subagent.updated',
        sessionId: value.sessionId,
        subagent: {
          id: subagent.id,
          label: subagent.label,
          status: subagent.status,
          parentSessionId: subagent.parentSessionId,
        },
      }
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
          ...(Array.isArray(question.choices)
            ? {
                choices: question.choices.flatMap((entry) => {
                  const choice = object(entry)
                  return choice !== undefined &&
                    typeof choice.id === 'string' &&
                    typeof choice.label === 'string'
                    ? [{ id: choice.id, label: choice.label }]
                    : []
                }),
              }
            : {}),
          ...(typeof question.multiSelect === 'boolean' ? { multiSelect: question.multiSelect } : {}),
          allowFreeText: question.allowFreeText,
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
  return valid.length === 0 ? timeline : { ...timeline, lastSequence: -1 }
}

function finiteSequence(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
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

function isJobStatus(
  value: unknown,
): value is 'running' | 'stopping' | 'completed' | 'failed' | 'killed' | 'cancelled' {
  return (
    value === 'running' ||
    value === 'stopping' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'killed' ||
    value === 'cancelled'
  )
}

function isSubagentStatus(
  value: unknown,
): value is 'idle' | 'running' | 'awaiting-input' | 'completed' | 'failed' {
  return (
    value === 'idle' ||
    value === 'running' ||
    value === 'awaiting-input' ||
    value === 'completed' ||
    value === 'failed'
  )
}

function isPermissionKind(value: unknown): value is 'allow-once' | 'deny' {
  return value === 'allow-once' || value === 'deny'
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
    typeof item.label === 'string' &&
    isJobStatus(item.status)
  )
}

function isSubagentView(value: unknown): value is SubagentView {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    typeof item.label === 'string' &&
    typeof item.parentSessionId === 'string' &&
    isSubagentStatus(item.status)
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
