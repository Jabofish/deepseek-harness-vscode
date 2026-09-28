import type {
  AgentConfiguration,
  PromptMode,
  SessionHistoryEvent,
  SubagentCatalog,
  SubagentView,
} from '@dsh-vscode/domain'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import { PluginInstallRecoveryController } from './plugin-install-recovery.js'
import { createAccountActions } from './store/account-actions.js'
import { createSettingsActions, type PresetSessionSyncTarget } from './store/settings-actions.js'
import { createFeatureActions } from './store/feature-actions.js'
import { defineStateView, type StoreWithoutStateView } from './store/state-view.js'
import { createJobActions } from './store/job-actions.js'
import { getVsCodeApi } from '../vscode-api.js'
import { ProtocolClient } from './protocol-client.js'
import type { AppStore, LiveHistoryAppender, StateSetter } from './store/types.js'
import { requestId } from './store/ids.js'
import { createPendingOpenBuffer } from './store/pending-open.js'
import { createGoalQueueActions } from './store/goal-queue-actions.js'
import { createSessionActions } from './store/session-actions.js'
import {
  createCommandDirectoryCache,
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
import { subscribeHostEvents } from './store/host-event-subscription.js'
import { createPromptActions } from './store/prompt-actions.js'
import { createHistoryActions } from './store/history-actions.js'
import { createSessionCreationActions } from './store/session-creation-actions.js'
import { createAppLifecycleActions } from './store/app-lifecycle-actions.js'
import { parseGoalViews } from './store/event-values.js'
import { mergeHistory } from './store/history-ledger.js'
import { parseDshSettingsSnapshot } from './store/host-settings.js'
import { createInitialState } from './store/initial-state.js'
import { sameGoalList, sameSessionSummaryList, strictListValues } from './store/list-equality.js'
import { normalizedModelSelection } from './store/model-catalog.js'
import { parsePluginInventory } from './store/plugin-parsers.js'
import { isSessionSummary, readPersistedWebviewState } from './store/session-guards.js'
import type { ProjectionSequenceIndex } from './store/session-projection.js'
import { refreshSessions, selectStartupSessionId } from './store/session-registry.js'
import { isSubagentView, parseSubagentCatalog } from './store/subagent.js'
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
  const rememberPromptMode = (promptMode: PromptMode): void => {
    composerPreferences = { ...composerPreferences, promptMode }
    persistWebviewState()
  }
  const rememberOpenFilePreference = (openFileId: string): void => {
    composerPreferences = { ...composerPreferences, openFileId }
    persistWebviewState()
  }
  const { executeCommandRequest, sendUserTurn } = createPromptActions({
    client,
    getState: () => state,
    rememberPromptMode,
    setState,
  })
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
  const unsubscribeHostEvents = subscribeHostEvents({
    accountActions,
    appendLiveHistory,
    callbacks,
    client,
    commandDirectory,
    featureActions,
    getState: () => state,
    invalidateFeedback,
    lifecycle: {
      advanceSessionModelDirectoryGeneration: () => {
        sessionModelDirectoryGeneration += 1
      },
      clearStartupRestorePending: () => {
        startupRestorePending = false
      },
      getOpenVersion: () => openVersion,
      incrementGoalReadGeneration: () => {
        goalReadGeneration += 1
      },
      isDisposed: () => disposed,
      setGoalActivationAvailable: (available) => {
        goalActivationAvailable = available
      },
    },
    loadSubagentCatalog,
    pendingOpenBuffer,
    pluginInstallRecovery,
    projectionSequences,
    refresh,
    refreshCommands,
    refreshLiveGoals,
    refreshSessionModelDirectoryForSession,
    reopenActiveView,
    scheduleGapBackfill,
    scheduleLedgerRebuild,
    rememberHostOnlyNodes,
    setState,
    turnWatchers,
  })
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
  const lifecycleActions = createAppLifecycleActions({
    applyBusyEnterPreference,
    attemptStartupRestore,
    checkDshUpdates,
    client,
    invalidateFeedback,
    markStartupRestoreArmed: () => {
      startupRestoreArmed = true
    },
    refresh,
  })
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
  const { loadOlderHistory } = createHistoryActions({
    client,
    flushPendingHistory,
    getOpenVersion: () => openVersion,
    getState: () => state,
    projectionSequences,
    rememberCoveredRanges,
    restoreGapNotices,
    restoreHostOnlyNodes,
    setState,
  })
  const sessionCreationActions = createSessionCreationActions({
    client,
    clearStartupRestorePending: () => {
      startupRestorePending = false
    },
    discardEditorContextForSessionSwitch: (sessionId) =>
      featureActions.discardEditorContextForSessionSwitch(sessionId),
    flushPendingHistory,
    getComposerPreferences: () => composerPreferences,
    getOpenIntent: () => openIntent,
    getPendingSend: () => pendingSend,
    getPendingSessionRevision: () => pendingSessionRevision,
    getState: () => state,
    nextOpenIntent: () => ++openIntent,
    nextOpenVersion: () => ++openVersion,
    nextPendingSessionRevision: () => ++pendingSessionRevision,
    openSession: open,
    persistWebviewState: () => persistWebviewState(),
    rememberComposerConfiguration,
    refresh,
    sendUserTurn,
    setPendingSend: (pending) => {
      pendingSend = pending
    },
    setState,
    stopJobsBeforeSessionOpen: () => jobActions.stopBeforeSessionOpen(),
  })
  const sessionActions = createSessionActions({
    client,
    getState: () => state,
    setState,
    executeCommandRequest,
    sendUserTurn,
    refreshCommands: (sessionId) => refreshCommands(sessionId),
    refreshSessionModelDirectoryForSession,
    rememberComposerConfiguration,
    rememberPromptMode,
    rememberOpenFileId: rememberOpenFilePreference,
    nextConfigurationGeneration: () => ++configurationGeneration,
    isConfigurationGenerationCurrent: (generation) => generation === configurationGeneration,
  })
  const goalQueueActions = createGoalQueueActions({
    client,
    getState: () => state,
    setState,
    refreshGoals: refreshLiveGoals,
  })

  const store: StoreWithoutStateView = {
    ...accountActions.methods,
    ...jobActions.methods,
    ...featureActions.methods,
    ...settingsActions,
    ...feedbackActions,
    ...interactionActions,
    ...sessionCatalogActions,
    ...sessionCreationActions,
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
    ...lifecycleActions,
    refreshSessions: refresh,
    refreshCommands: (sessionId) => refreshCommands(sessionId),
    refreshSessionModels: async (sessionId) => {
      const target = sessionId ?? state.activeSessionId
      if (target === undefined) return
      await refreshSessionModelDirectoryForSession(target)
    },
    openSession: open,
    loadOlderHistory,
    openSubagent,
    ...sessionActions,
    ...goalQueueActions,
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
      unsubscribeHostEvents()
      client.dispose()
      listeners.clear()
    },
  }
  return defineStateView(store, () => state)
}
