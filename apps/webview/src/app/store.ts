import { translate } from '../i18n.js'
import type {
  AgentConfiguration,
  MessageAttachment,
  PluginInstallProgressView,
  PromptAttachment,
  RunningInputMode,
  SessionHistoryEvent,
  SubagentCatalog,
  SubagentView,
} from '@dsh-vscode/domain'
import { parseSlashCommand, resolvePromptMode } from '@dsh-vscode/domain'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import { diagnosticsSnapshotSchema } from '@dsh-vscode/webview-protocol'
import { PluginInstallRecoveryController } from './plugin-install-recovery.js'
import { createAccountActions } from './store/account-actions.js'
import { createSettingsActions, type PresetSessionSyncTarget } from './store/settings-actions.js'
import { createFeatureActions } from './store/feature-actions.js'
import { defineStateView, type StoreWithoutStateView } from './store/state-view.js'
import { createJobActions } from './store/job-actions.js'
import { getVsCodeApi } from '../vscode-api.js'
import { ProtocolClient } from './protocol-client.js'
import type { ActiveSubagent, AppStore, LiveHistoryAppender, StateSetter } from './store/types.js'
import { requestId } from './store/ids.js'
import { createPendingOpenBuffer } from './store/pending-open.js'
import { applyKnownCommand, hasDynamicCommand, promptModeAfterCommand } from './store/agent-config.js'
import {
  createCommandDirectoryCache,
  isCommandDirectoryRefresh,
  isModelCatalogRefresh,
  readCommandList,
  refreshSessionModelDirectory,
} from './store/command-directory.js'
import { createDshUpdateActions } from './store/dsh-update.js'
import { createGapHealing } from './store/gap-heal.js'
import { createFeedbackCache } from './store/feedback-cache.js'
import { createFeedbackActions } from './store/feedback-actions.js'
import { createInteractionActions } from './store/interaction-actions.js'
import { createSessionCatalogActions } from './store/session-catalog-actions.js'
import { createSessionOpenController } from './store/session-open-controller.js'
import { createTurnWatchers } from './store/turn-watchers.js'
import { parseHostDomainEvent, timelineSequenceOptions } from './store/event-parser.js'
import { parseGoalViews } from './store/event-values.js'
import { mergeHistory, newestHistorySequence, oldestHistorySequence } from './store/history-ledger.js'
import {
  historyPageCoverage,
  hydrateTimelineFromHistoryEvents,
  mergeLiveTransientNodes,
  parseSessionHistoryPage,
} from './store/history-replay.js'
import { applyHostMessage, backendEventSessionId, latestTodos } from './store/host-message-reducers.js'
import { parseDshSettingsSnapshot, refreshProvidersAndModels } from './store/host-settings.js'
import { createInitialState } from './store/initial-state.js'
import { sameGoalList, sameSessionSummaryList, strictListValues, stringList } from './store/list-equality.js'
import {
  createDefaultConfiguration,
  isAgentConfiguration,
  normalizedModelSelection,
} from './store/model-catalog.js'
import { parsePluginInventory } from './store/plugin-parsers.js'
import { isSessionSummary, readPersistedWebviewState } from './store/session-guards.js'
import type { ProjectionSequenceIndex } from './store/session-projection.js'
import { clearedActiveSession, setSessionProjection } from './store/session-projection.js'
import {
  findReusableBlankSession,
  refreshSessions,
  selectStartupSessionId,
} from './store/session-registry.js'
import { isSubagentView, parseSubagentCatalog, parseSubagentHistory } from './store/subagent.js'
import { object } from './store/unknown-record.js'

export type {
  ActiveSubagent,
  AppActions,
  AppState,
  AppStore,
  DshSettingsSnapshot,
  IngestedFile,
  OpenFileCandidate,
  ReferenceCandidate,
  WebviewBackendState,
} from './store/types.js'
export type { JobFollowState } from './store/job-follow.js'

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

const DSH_RC11_VERSION = '0.1.1-rc.1'
const DSH_RC12_VERSION = '0.1.1-rc.2'

export function createAppStore(client = new ProtocolClient(getVsCodeApi())): AppStore {
  const vscodeApi = getVsCodeApi()
  let persistedWebviewState = readPersistedWebviewState(vscodeApi.getState())
  let composerPreferences = persistedWebviewState.composerPreferences ?? {}
  let state = createInitialState(composerPreferences)
  // Projection values arrive from both the Alpha Session/follow stream and
  // the independent session/control stream. Keep their DSH cut outside the
  // public state so an older snapshot cannot overwrite a newer live value.
  const projectionSequences: ProjectionSequenceIndex = {
    perKey: new Map(),
    baselines: new Map(),
    queueBySession: new Map(),
    connectionIdentity: undefined,
  }
  const listeners = new Set<() => void>()
  const turnWatchers = createTurnWatchers({ isDisposed: () => disposed })
  let notifyTimer: number | undefined
  let pendingHistorySessionId: string | undefined
  let pendingHistory: SessionHistoryEvent[] = []
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
  const feedbackCache = createFeedbackCache({ client, setState, getState: () => state })
  const invalidateFeedback = feedbackCache.invalidate
  const pluginInstallRecovery = new PluginInstallRecoveryController({
    featureRequest: <T>(request: FeatureRequest): Promise<T> => client.featureRequest<T>(request),
    requestId,
    onStateChange: (pluginInstallOperation, refreshCatalog) =>
      setState((current) => ({
        ...current,
        pluginInstallOperation,
        ...(refreshCatalog ? { pluginInventoryRevision: current.pluginInventoryRevision + 1 } : {}),
      })),
  })
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
  const accountActions = createAccountActions({ client, getState: () => state, setState })
  const jobActions = createJobActions({ client, getState: () => state, setState })
  const featureActions = createFeatureActions({
    client,
    getState: () => state,
    setState,
    sessionWorkspaceFolderId,
  })
  const gapHealing = createGapHealing({
    client,
    setState,
    getState: () => state,
    getOpenVersion: () => openVersion,
    isDisposed: () => disposed,
    flushPendingHistory,
    notifyBatchMs: STORE_NOTIFY_BATCH_MS,
  })
  const {
    scheduleGapBackfill,
    scheduleLedgerRebuild,
    restoreGapNotices,
    restoreHostOnlyNodes,
    rememberHostOnlyNodes,
    rememberCoveredRanges,
  } = gapHealing
  const persistWebviewState = (overrides: { readonly activeSessionId?: string } = {}): void => {
    const activeSessionId = overrides.activeSessionId ?? state.activeSessionId
    persistedWebviewState =
      activeSessionId === undefined
        ? { version: 1, composerPreferences }
        : { version: 1, composerPreferences, activeSessionId }
    vscodeApi.setState(persistedWebviewState)
  }
  const rememberComposerConfiguration = (configuration: AgentConfiguration): void => {
    const model = normalizedModelSelection(configuration.model)
    const rememberedModel = model ?? composerPreferences.model
    composerPreferences = {
      ...composerPreferences,
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
  let sessionModelDirectoryGeneration = 0
  let configurationGeneration = 0
  let presetRosterGeneration = 0
  let pendingSessionRevision = 0
  let pendingSend: { readonly revision: number; readonly promise: Promise<void> } | undefined
  const capturePresetSessionTarget = (): PresetSessionSyncTarget | undefined => {
    const pending = state.pendingSession
    if (pending !== undefined && pendingSend?.revision !== pending.revision) {
      if (
        pending.createdSessionId === undefined ||
        state.sessions.some(
          (session) => session.id === pending.createdSessionId && session.blank && session.status === 'idle',
        )
      )
        return {
          kind: 'pending',
          revision: pending.revision,
          ...(pending.createdSessionId === undefined ? {} : { createdSessionId: pending.createdSessionId }),
          configuration: pending.configuration,
        }
    }
    const sessionId = state.activeSessionId
    const summary = state.sessions.find((session) => session.id === sessionId)
    if (
      sessionId !== undefined &&
      state.activeSubagent === undefined &&
      state.configuration !== undefined &&
      summary?.blank === true &&
      summary.status === 'idle'
    )
      return { kind: 'active', sessionId, configuration: state.configuration }
    return undefined
  }
  const presetSessionTargetIsCurrent = (target: PresetSessionSyncTarget): boolean => {
    if (target.kind === 'pending') {
      const pending = state.pendingSession
      return (
        pending?.revision === target.revision &&
        pending.createdSessionId === target.createdSessionId &&
        pendingSend?.revision !== target.revision &&
        pending.configuration.preset === target.configuration.preset &&
        (target.createdSessionId === undefined ||
          state.sessions.some(
            (session) => session.id === target.createdSessionId && session.blank && session.status === 'idle',
          ))
      )
    }
    const summary = state.sessions.find((session) => session.id === target.sessionId)
    return (
      state.activeSessionId === target.sessionId &&
      state.activeSubagent === undefined &&
      state.configuration?.preset === target.configuration.preset &&
      summary?.blank === true &&
      summary.status === 'idle'
    )
  }
  const synchronizeBlankSessionPreset = async (
    target: PresetSessionSyncTarget,
    preset: string,
  ): Promise<void> => {
    if (target.configuration.preset === preset || !presetSessionTargetIsCurrent(target)) return
    const configuration = { ...target.configuration, preset }
    if (target.kind === 'pending' && target.createdSessionId === undefined) {
      setState((current) => {
        const pending = current.pendingSession
        if (
          pending?.revision !== target.revision ||
          pending.createdSessionId !== undefined ||
          pending.configuration.preset !== target.configuration.preset ||
          pendingSend?.revision === target.revision
        )
          return current
        return { ...current, pendingSession: { ...pending, configuration } }
      })
      return
    }
    if (!presetSessionTargetIsCurrent(target)) return
    const sessionId = target.kind === 'active' ? target.sessionId : target.createdSessionId
    if (sessionId === undefined) return
    const generation = ++configurationGeneration
    await client.request<unknown>({
      type: 'session.configure',
      requestId: requestId(),
      payload: { sessionId, configuration },
    })
    if (generation !== configurationGeneration || !presetSessionTargetIsCurrent(target)) return
    if (target.kind === 'active')
      setState((current) => {
        const summary = current.sessions.find((session) => session.id === target.sessionId)
        if (
          current.activeSessionId !== target.sessionId ||
          current.activeSubagent !== undefined ||
          current.configuration?.preset !== target.configuration.preset ||
          summary?.blank !== true ||
          summary.status !== 'idle'
        )
          return current
        return { ...current, configuration }
      })
    else
      setState((current) => {
        const pending = current.pendingSession
        const summary = current.sessions.find((session) => session.id === target.createdSessionId)
        if (
          pending?.revision !== target.revision ||
          pending.createdSessionId !== target.createdSessionId ||
          pending.configuration.preset !== target.configuration.preset ||
          pendingSend?.revision === target.revision ||
          summary?.blank !== true ||
          summary.status !== 'idle'
        )
          return current
        return { ...current, pendingSession: { ...pending, configuration } }
      })
  }
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
  const refreshSessionModelDirectoryForSession = (sessionId: string): Promise<void> => {
    // This store projects one active session's catalog. An off-screen refresh
    // has nowhere useful to merge and must not retire that active session's
    // pending directory read.
    if (state.activeSessionId !== sessionId) return Promise.resolve()
    const generation = ++sessionModelDirectoryGeneration
    const version = openVersion
    return refreshSessionModelDirectory(
      client,
      setState,
      sessionId,
      () => !disposed && version === openVersion && generation === sessionModelDirectoryGeneration,
    )
  }
  // A newly-created store has not yet made its one automatic session choice.
  // Keep that decision pending when the first registry snapshot is empty: the
  // DSH workspace/session registries can publish in adjacent turns.
  let startupRestorePending = true
  let startupRestoreArmed = false
  let startupRestorePromise: Promise<void> | undefined
  const pendingOpenBuffer = createPendingOpenBuffer(() => openVersion)
  const commandDirectory = createCommandDirectoryCache((sessionId) => readCommandList(client, sessionId))
  const loadCommandDirectory = (
    sessionId: string,
    force?: boolean,
  ): ReturnType<typeof commandDirectory.load> => commandDirectory.load(sessionId, force)
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
    if (
      message.type === 'event' &&
      (message.name === 'connection.lost' ||
        (message.name === 'connection.snapshot' && object(message.payload)?.kind !== 'connected'))
    )
      // Retire reads from the connection that is going away. The replacement
      // session open starts a fresh generation when it can read its own catalog.
      sessionModelDirectoryGeneration += 1
    if (
      message.type === 'event' &&
      (message.name === 'connection.snapshot' || message.name === 'connection.lost')
    ) {
      const snapshot = message.name === 'connection.snapshot' ? object(message.payload) : undefined
      const identity =
        snapshot?.kind === 'connected' &&
        typeof snapshot.backendInstanceId === 'string' &&
        typeof snapshot.connectionGeneration === 'number'
          ? `${snapshot.backendInstanceId}:${snapshot.connectionGeneration}`
          : undefined
      accountActions.applyConnectionIdentity(identity)
    }
    const parsedEvent = parseHostDomainEvent(message)
    if (parsedEvent?.type === 'turn.started' || parsedEvent?.type === 'turn.ended')
      turnWatchers.notify(parsedEvent)
    const messageSessionId =
      parsedEvent === undefined || parsedEvent === null ? undefined : backendEventSessionId(parsedEvent)
    const previousLastSequence = state.timeline.lastSequence
    let deferredToOpen = false
    let pendingOpenReady = false
    if (messageSessionId !== undefined) {
      const pending = pendingOpenBuffer.capture(messageSessionId, message)
      if (pending !== undefined) {
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
      message.name === 'connection.snapshot' &&
      object(message.payload)?.kind === 'connected'
    )
      setState((current) => ({
        ...current,
        pluginInventoryRevision: current.pluginInventoryRevision + 1,
        pluginInstallProgress: undefined,
      }))
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
      setState((current) => ({ ...current, pluginInstallProgress: undefined }))
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
      if (refreshSessionId !== undefined) void refreshSessionModelDirectoryForSession(refreshSessionId)
    }
    if (
      message.type === 'event' &&
      message.name === 'connection.snapshot' &&
      object(message.payload)?.kind === 'connected'
    ) {
      commandDirectory.invalidate()
      void refreshCommands(undefined, true)
    }
    if (message.type === 'event' && message.name === 'connection.lost') {
      commandDirectory.invalidate()
      invalidateFeedback()
    }
    if (
      message.type === 'event' &&
      (message.name === 'workspace.changed' || message.name === 'workspace.removed')
    )
      void featureActions.discardEditorContextForWorkspaceChange()
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
          if (accountActions.applyFeatureEvent(message)) return
          if (message.name === 'plugin.manager.changed')
            setState((current) => ({
              ...current,
              pluginInventoryRevision: current.pluginInventoryRevision + 1,
              pluginInstallProgress: undefined,
            }))
          if (message.name === 'plugin.install.progress') {
            const progress: PluginInstallProgressView = {
              requestId: message.requestId,
              phase: message.phase,
              ...(message.attemptIndex === undefined ? {} : { attemptIndex: message.attemptIndex }),
              ...(message.attemptTotal === undefined ? {} : { attemptTotal: message.attemptTotal }),
            }
            pluginInstallRecovery.progress(progress)
            setState((current) => ({ ...current, pluginInstallProgress: progress }))
          }
          if (featureActions.applyFeatureEvent(message)) return
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
  const { open, openSubagent } = createSessionOpenController({
    client,
    getState: () => state,
    setState,
    getComposerPreferences: () => composerPreferences,
    projectionSequences,
    pendingOpenBuffer,
    featureActions,
    jobActions,
    gapHealing,
    feedbackCache,
    commandDirectory,
    requestSessionOpen,
    resolveSubagentOpen,
    loadCommandDirectory,
    loadSubagentCatalog,
    sessionWorkspaceFolderId,
    persistWebviewState,
    flushPendingHistory,
    nextOpenIntent: () => ++openIntent,
    getOpenIntent: () => openIntent,
    nextOpenVersion: () => ++openVersion,
    getOpenVersion: () => openVersion,
    nextSessionModelDirectoryGeneration: () => ++sessionModelDirectoryGeneration,
    getSessionModelDirectoryGeneration: () => sessionModelDirectoryGeneration,
    getGoalReadGeneration: () => goalReadGeneration,
    setGoalActivationAvailable: () => {
      goalActivationAvailable = true
    },
    clearStartupRestorePending: () => {
      startupRestorePending = false
    },
  })
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
  const { checkDshUpdates, installDshVersion } = createDshUpdateActions({ client, setState })
  const settingsActions = createSettingsActions({
    client,
    setState,
    applyBusyEnter,
    capturePresetSessionTarget,
    nextPresetRosterGeneration: () => ++presetRosterGeneration,
    isPresetRosterCurrent: (generation) => generation === presetRosterGeneration,
    synchronizeBlankSessionPreset,
  })
  const feedbackActions = createFeedbackActions({ client, setState, getState: () => state, feedbackCache })
  const interactionActions = createInteractionActions(client, setState)
  const sessionCatalogActions = createSessionCatalogActions({
    client,
    getState: () => state,
    setState,
    refresh,
    open,
    loadArchivedSessions,
    nextOpenIntent: () => ++openIntent,
    currentOpenIntent: () => openIntent,
    isOpenIntentCurrent: (intent) => intent === openIntent,
  })
  const store: StoreWithoutStateView = {
    ...accountActions.methods,
    ...jobActions.methods,
    ...featureActions.methods,
    ...settingsActions,
    ...feedbackActions,
    ...interactionActions,
    ...sessionCatalogActions,
    get sessionRestore() {
      return state.sessionRestore === true
    },
    get feedbackUnavailable() {
      return state.feedbackUnavailable ?? false
    },
    get unavailableLists() {
      return state.unavailableLists ?? []
    },
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    watchSessionTurnEnd: (sessionId) => turnWatchers.watch(sessionId),
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
    refreshCommands: (sessionId) => refreshCommands(sessionId),
    refreshSessionModels: async (sessionId) => {
      const target = sessionId ?? state.activeSessionId
      if (target === undefined) return
      await refreshSessionModelDirectoryForSession(target)
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
                payload: { sessionId, beforeSeq, maxMessages: 200 },
              }
            : {
                type: 'session.history',
                requestId: requestId(),
                payload: { sessionId, beforeSeq, maxMessages: 200, pagePurpose: 'transcript' },
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
      await refreshSessionModelDirectoryForSession(sessionId)
    },
    executeCommand: async (sessionId, command, attachments = []) => {
      if ((await executeCommandRequest(sessionId, command, attachments)) === 'executed') return true
      // The palette hands the picked line to the command surface; a skill row
      // has no command behind it, so the same line is submitted as the prompt
      // gesture it spells.
      await sendUserTurn(sessionId, command, attachments, 'queue', undefined)
      return true
    },
    stageSession: async (workspaceId, presetId) => {
      const workspace =
        (workspaceId === undefined
          ? undefined
          : state.workspaces.find((entry) => entry.id === workspaceId)) ?? state.workspaces[0]
      if (workspace === undefined) throw new Error(translate('app.workspaceLoadingDescription'))
      const defaultConfiguration = createDefaultConfiguration(state, composerPreferences)
      const configuration =
        presetId === undefined ? defaultConfiguration : { ...defaultConfiguration, preset: presetId }
      const revision = ++pendingSessionRevision
      const navigationIntent = ++openIntent
      ++openVersion
      startupRestorePending = false
      jobActions.stopBeforeSessionOpen()
      flushPendingHistory()
      await featureActions.discardEditorContextForSessionSwitch('')
      if (revision !== pendingSessionRevision || navigationIntent !== openIntent) return
      setState((current) => ({
        ...current,
        ...clearedActiveSession(current, current.activeSessionId ?? ''),
        pendingSession: { revision, workspaceId: workspace.id, configuration },
        editorContext: [],
        editorContextAvailableKinds: [],
        editorContextLoading: false,
        drawer: undefined,
      }))
      persistWebviewState()
    },
    configurePendingSession: (configuration) => {
      if (!isAgentConfiguration(configuration)) throw new Error(translate('app.error.sessionSettings'))
      setState((current) =>
        current.pendingSession === undefined
          ? current
          : {
              ...current,
              pendingSession: { ...current.pendingSession, configuration },
            },
      )
      rememberComposerConfiguration(configuration)
    },
    sendPendingPrompt: (text, attachments, mode) => {
      const pending = state.pendingSession
      if (pending === undefined) return Promise.reject(new Error(translate('app.error.createSession')))
      if (pendingSend?.revision === pending.revision) return pendingSend.promise
      if (text.trim() === '' && attachments.length === 0)
        return Promise.reject(new Error(translate('app.error.prompt')))
      if (parseSlashCommand(text) !== undefined)
        return Promise.reject(new Error(translate('app.error.commandBeforeFirstMessage')))
      const send = (async () => {
        let sessionId = pending.createdSessionId
        if (sessionId === undefined) {
          const workspace = state.workspaces.find((entry) => entry.id === pending.workspaceId)
          const reusableBlank =
            workspace === undefined
              ? undefined
              : findReusableBlankSession(state.sessions, state.archivedSessionIds, workspace)
          if (state.connectedDshVersion === DSH_RC12_VERSION && reusableBlank !== undefined) {
            sessionId = reusableBlank.id
          } else {
            const rc11ReusableBlank =
              state.connectedDshVersion === DSH_RC11_VERSION ? reusableBlank : undefined
            const result = object(
              await client.request<unknown>({
                type: 'session.create',
                requestId: requestId(),
                payload: {
                  workspaceId: pending.workspaceId,
                  ...(rc11ReusableBlank === undefined
                    ? {}
                    : { sessionId: rc11ReusableBlank.id, reuseWorkspaceBlank: true as const }),
                  configuration: pending.configuration,
                },
              }),
            )
            if (typeof result?.id !== 'string' || result.id.trim() === '')
              throw new Error(translate('app.error.createSession'))
            sessionId = result.id
          }
          if (sessionId === undefined) throw new Error(translate('app.error.createSession'))
          const createdSessionId = sessionId
          setState((current) =>
            current.pendingSession?.revision === pending.revision
              ? {
                  ...current,
                  pendingSession: { ...current.pendingSession, createdSessionId },
                }
              : current,
          )
        }
        if (state.pendingSession?.revision !== pending.revision) return
        await refresh()
        if (state.pendingSession?.revision !== pending.revision) return
        await open(sessionId)
        if (state.activeSessionId !== sessionId) return
        await sendUserTurn(sessionId, text, attachments, mode, undefined)
      })()
      const promise = send.finally(() => {
        if (pendingSend?.revision === pending.revision) pendingSend = undefined
      })
      pendingSend = { revision: pending.revision, promise }
      return promise
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
      let firstFailure: unknown
      let failed = false
      for (const item of targets) {
        try {
          await client.request<unknown>({
            type: 'session.queue.steer',
            requestId: requestId(),
            payload: { inputId: item.id },
          })
        } catch (reason: unknown) {
          // Try every row, then report one failure to the App's public-error
          // boundary instead of silently losing a rejected steer request.
          if (!failed) firstFailure = reason
          failed = true
        }
      }
      if (failed) throw firstFailure
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
    rememberOpenFile: (candidateId) => {
      const normalized = candidateId.trim()
      if (normalized === '') return
      composerPreferences = { ...composerPreferences, openFileId: normalized }
      setState((current) => ({ ...current, preferredOpenFileId: normalized }))
      persistWebviewState()
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
    loadPluginInventory: async () =>
      parsePluginInventory(
        await client.request<unknown>({ type: 'plugin.inventory', requestId: requestId() }),
      ),
    startPluginInstall: (input) => pluginInstallRecovery.start(input),
    cancelPluginInstall: () => pluginInstallRecovery.cancel(),
    recoverPluginInstall: () => pluginInstallRecovery.recover(),
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
    featureRequest: <T>(request: FeatureRequest): Promise<T> => client.featureRequest<T>(request),
    subscribeFeature: (listener) => client.subscribeFeature(listener),
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
      // In-flight opens, rebuilds and gap backfills all guard on openVersion;
      // bumping it retires them without letting a late continuation touch a
      // disposed store. Gap backfills also read `disposed`: they outlive a
      // superseded open on purpose so their announced range is not lost.
      disposed = true
      turnWatchers.disposeAll()
      pluginInstallRecovery.dispose()
      openVersion += 1
      sessionModelDirectoryGeneration += 1
      accountActions.invalidate()
      gapHealing.dispose()
      pendingHistory = []
      pendingHistorySessionId = undefined
      invalidateFeedback()
      unsubscribe()
      unsubscribeFeature()
      client.dispose()
      listeners.clear()
    },
  }
  return defineStateView(store, () => state)
}
