import { translate } from '../i18n.js'
import type {
  AgentConfiguration,
  BackendEvent,
  DshUpdateSnapshot,
  DynamicCommand,
  GoalView,
  JobView,
  MessageAttachment,
  PluginInstallProgressView,
  PromptAttachment,
  QueuedInput,
  RunningInputMode,
  SessionHistoryEvent,
  SessionSequenceRange,
  SubagentCatalog,
  SubagentView,
} from '@dsh-vscode/domain'
import { parseSlashCommand, resolvePromptMode } from '@dsh-vscode/domain'
import type { TimelineNode, TimelineState } from '@dsh-vscode/timeline'
import { isRedundantTurnFailureNotice, reduceTimeline } from '@dsh-vscode/timeline'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import { diagnosticsSnapshotSchema } from '@dsh-vscode/webview-protocol'
import { PluginInstallRecoveryController } from './plugin-install-recovery.js'
import { createAccountActions } from './store/account-actions.js'
import { createFeatureActions } from './store/feature-actions.js'
import { createJobActions } from './store/job-actions.js'
import { getVsCodeApi } from '../vscode-api.js'
import { ProtocolClient } from './protocol-client.js'
import type { ActiveSubagent, AppStore, LiveHistoryAppender, StateSetter } from './store/types.js'
import { requestId } from './store/ids.js'
import { createPendingOpenBuffer } from './store/pending-open.js'
import {
  applyKnownCommand,
  hasDynamicCommand,
  parsePresetRoster,
  promptModeAfterCommand,
  promptModeForConfiguration,
} from './store/agent-config.js'
import {
  isCommandDirectoryRefresh,
  isModelCatalogRefresh,
  loadSessionModelDirectory,
  mergeSessionModelDirectory,
  readCommandList,
  refreshSessionModelDirectory,
} from './store/command-directory.js'
import { attachmentFromResult, imageDataUri, openFileCandidatesFromResult } from './store/editor-context.js'
import { parseHostDomainEvent, timelineSequenceOptions } from './store/event-parser.js'
import { isGoalView, isJobView, isQueuedInput, nonEmptyString, parseGoalViews } from './store/event-values.js'
import { feedbackRecord, isMessageFeedbackItem } from './store/feature-parsers.js'
import {
  historyCoversSequenceRange,
  historySequenceRanges,
  mergeHistory,
  mergeSequenceRanges,
  newestHistorySequence,
  oldestHistorySequence,
  sequenceRangesCover,
} from './store/history-ledger.js'
import {
  historyPageCoverage,
  hydrateTimelineFromEntries,
  hydrateTimelineFromHistoryEvents,
  mergeLiveTransientNodes,
  optionalSequence,
  parseSessionHistoryPage,
  parseSessionHistoryWithTimeline,
} from './store/history-replay.js'
import {
  applyHostMessage,
  backendEventSessionId,
  hostOnlyInsertIndex,
  latestTodos,
  replayHostMessages,
  withPresetSelectionEnabled,
} from './store/host-message-reducers.js'
import {
  parseDshSettingsSnapshot,
  parseDshUpdateSnapshot,
  parseExtensionSettings,
  refreshProvidersAndModels,
} from './store/host-settings.js'
import { EMPTY_SUBAGENT_CATALOG, createInitialState } from './store/initial-state.js'
import {
  arraysEqual,
  deduplicateSessionSummaries,
  sameGoalList,
  sameSessionSummaryList,
  strictListValues,
  stringList,
  uniqueStrings,
} from './store/list-equality.js'
import {
  createDefaultConfiguration,
  isAgentConfiguration,
  normalizedModelSelection,
  parseCustomProviderCreateResult,
  parseDiscoveredModels,
} from './store/model-catalog.js'
import { parsePluginInventory } from './store/plugin-parsers.js'
import { referenceCandidates } from './store/references.js'
import {
  isSessionOpenDetail,
  isSessionSummary,
  questionResponsePayload,
  readPersistedWebviewState,
} from './store/session-guards.js'
import type { ProjectionSequenceIndex } from './store/session-projection.js'
import {
  clearedActiveSession,
  setSessionProjection,
  upsertOpenedSession,
} from './store/session-projection.js'
import type { FeedbackListResult } from './store/session-registry.js'
import {
  findReusableBlankSession,
  isFeedbackCapabilityUnavailable,
  refreshSessions,
  safeFeedbackList,
  safeList,
  selectStartupSessionId,
} from './store/session-registry.js'
import {
  isSubagentView,
  nextForkTitle,
  parseSubagentCatalog,
  parseSubagentHistory,
} from './store/subagent.js'
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

interface SessionTurnWatcher {
  readonly sessionId: string
  turn: number | undefined
  finish(): void
  dispose(): void
}

type PresetSessionSyncTarget =
  | {
      readonly kind: 'active'
      readonly sessionId: string
      readonly configuration: AgentConfiguration
    }
  | {
      readonly kind: 'pending'
      readonly revision: number
      readonly createdSessionId?: string
      readonly configuration: AgentConfiguration
    }

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
  const sessionTurnWatchers = new Set<SessionTurnWatcher>()
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
      const target = nodes ?? timeline.nodes
      // A notice retained for a session that was not open was reduced on its
      // own, so it never saw the durable turn row that carries the same
      // failure. The turn row is the one history replays; drop the twin.
      if (isRedundantTurnFailureNotice(entry.node, target)) continue
      const mutable = nodes ?? (nodes = [...timeline.nodes])
      const index = Math.max(hostOnlyInsertIndex(mutable, entry.anchors), previousIndex + 1)
      mutable.splice(index, 0, entry.node)
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
              payload: {
                sessionId,
                beforeSeq,
                maxMessages: GAP_BACKFILL_PAGE_MESSAGES,
                pagePurpose: 'gap-recovery',
              },
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
    if (parsedEvent?.type === 'turn.started' || parsedEvent?.type === 'turn.ended') {
      for (const watcher of sessionTurnWatchers) {
        if (watcher.sessionId !== parsedEvent.sessionId) continue
        if (parsedEvent.type === 'turn.started') watcher.turn = parsedEvent.turn
        else if (watcher.turn === parsedEvent.turn) watcher.finish()
      }
    }
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
    jobActions.stopBeforeSessionOpen()
    if (options.startup !== true) startupRestorePending = false
    flushPendingHistory()
    const version = ++openVersion
    const modelDirectoryGeneration = ++sessionModelDirectoryGeneration
    feedbackReadySessions.delete(sessionId)
    featureActions.retireForSessionSwitch()
    const pending = pendingOpenBuffer.create(sessionId, version)
    // Events delivered after this open began must be replayed after the
    // advisory snapshots, even when the critical history request has not
    // produced first paint yet.
    const advisoryReplayStart = pending.messages.length
    let completed = false
    let advisoryPending = false
    try {
      await featureActions.discardEditorContextForSessionSwitch(sessionId)
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
      const initialMessages = pendingOpenBuffer.messagesAfterReplay(pending)
      setState((current) =>
        replayHostMessages(
          {
            ...current,
            activeSessionId: sessionId,
            pendingSession: undefined,
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
        if (version !== openVersion || modelDirectoryGeneration !== sessionModelDirectoryGeneration) return
        setState((current) =>
          version === openVersion && modelDirectoryGeneration === sessionModelDirectoryGeneration
            ? mergeSessionModelDirectory(current, sessionId, read)
            : current,
        )
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
          const pendingMessages = pendingOpenBuffer
            .messagesFrom(pending, advisoryReplayStart)
            .filter((message) => message.type !== 'event' || message.name !== 'session.gap')
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
          featureActions.refreshSessionScopedStates(sessionId)
          featureActions.refreshEditorContextForOpen(workspaceFolderId)
        })
        .catch(() => undefined)
        .finally(() => {
          advisoryPending = false
          pendingOpenBuffer.settle(pending, version === openVersion)
        })
      completed = true
    } finally {
      if (!advisoryPending) pendingOpenBuffer.settle(pending, completed)
    }
  }
  const openSubagent = async (entry: SubagentView, parentAvailable: boolean): Promise<void> => {
    // A direct child open (drawer, task row) also supersedes an in-flight
    // by-id resolution inside `open`.
    openIntent += 1
    jobActions.stopBeforeSessionOpen()
    flushPendingHistory()
    const version = ++openVersion
    feedbackReadySessions.delete(entry.id)
    featureActions.retirePromptTemplatesForSubagentSwitch()
    const pending = pendingOpenBuffer.create(entry.id, version)
    // The history and advisory reads overlap. Preserve every event delivered
    // after this open began for the final advisory replay.
    const advisoryReplayStart = pending.messages.length
    let completed = false
    const workspaceId =
      state.sessions.find((session) => session.id === state.activeSessionId)?.workspaceId ??
      state.activeSubagent?.workspaceId ??
      ''
    try {
      await featureActions.discardEditorContextForSessionSwitch(entry.id)
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
      const initialMessages = pendingOpenBuffer.messagesAfterReplay(pending)
      setState((current) =>
        replayHostMessages(
          {
            ...current,
            activeSessionId: entry.id,
            pendingSession: undefined,
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
      const pendingMessages = pendingOpenBuffer.messagesFrom(pending, advisoryReplayStart)
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
      featureActions.refreshSessionScopedStates(entry.id)
      completed = true
    } finally {
      pendingOpenBuffer.settle(pending, completed)
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
    ...accountActions.methods,
    ...jobActions.methods,
    ...featureActions.methods,
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
    get pendingSession() {
      return state.pendingSession
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
    get pluginInstallProgress() {
      return state.pluginInstallProgress
    },
    get pluginInstallOperation() {
      return state.pluginInstallOperation
    },
    get accountLifecycleAvailable() {
      return state.accountLifecycleAvailable
    },
    get accountLifecycle() {
      return state.accountLifecycle
    },
    get accountLifecycleLoading() {
      return state.accountLifecycleLoading
    },
    get accountLifecycleBusy() {
      return state.accountLifecycleBusy
    },
    get accountLifecycleImpact() {
      return state.accountLifecycleImpact
    },
    get accountSessionExpired() {
      return state.accountSessionExpired
    },
    get accountLifecycleError() {
      return state.accountLifecycleError
    },
    get accountLifecycleRequestFailed() {
      return state.accountLifecycleRequestFailed
    },
    get accountProfileDetails() {
      return state.accountProfileDetails
    },
    get accountProfileLoading() {
      return state.accountProfileLoading
    },
    get accountProfileRequestFailed() {
      return state.accountProfileRequestFailed
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
    watchSessionTurnEnd: (sessionId) => {
      let resolveCompletion!: () => void
      let rejectCompletion!: (reason: Error) => void
      let settled = false
      const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve
        rejectCompletion = reject
      })
      // The App may still be awaiting sendPrompt when disposal rejects this watcher.
      void completion.catch(() => undefined)
      const finish = (): void => {
        if (settled) return
        settled = true
        sessionTurnWatchers.delete(watcher)
        resolveCompletion()
      }
      const disposeWatcher = (): void => {
        if (settled) return
        settled = true
        sessionTurnWatchers.delete(watcher)
        const error = new Error('AppStore disposed before the Session turn ended.')
        error.name = 'SessionTurnWatchDisposedError'
        rejectCompletion(error)
      }
      const watcher: SessionTurnWatcher = { sessionId, turn: undefined, finish, dispose: disposeWatcher }
      if (disposed) disposeWatcher()
      else sessionTurnWatchers.add(watcher)
      return { completion, dispose: disposeWatcher }
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
      if (trimmed === '') return { items: [] }
      const result = await client.request<unknown>({
        type: 'session.list',
        requestId: requestId(),
        payload: { search: trimmed, archived: false },
      })
      const items = strictListValues(result, isSessionSummary)
      const record = object(result)
      if (items === undefined) throw new Error('Malformed session search response.')
      if (
        record !== undefined &&
        Object.hasOwn(record, 'searchHasMore') &&
        typeof record.searchHasMore !== 'boolean'
      )
        throw new Error('Malformed session search response.')
      return {
        items: deduplicateSessionSummaries(items),
        ...(typeof record?.searchHasMore === 'boolean' ? { searchHasMore: record.searchHasMore } : {}),
      }
    },
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
    openKeyboardShortcuts: async () => {
      await client.request<unknown>({ type: 'settings.openKeyboardShortcuts', requestId: requestId() })
    },
    updateDshSetting: async (path, value, expectedRevision) => {
      await client.request<unknown>({
        type: 'settings.update',
        requestId: requestId(),
        payload: { path, value, expectedRevision },
      })
    },
    unsetDshSetting: async (path, expectedRevision) => {
      await client.request<unknown>({
        type: 'settings.unset',
        requestId: requestId(),
        payload: { path, expectedRevision },
      })
    },
    mutateDshSettings: async (namespace, operations, expectedRevision) => {
      await client.request<unknown>({
        type: 'settings.mutate',
        requestId: requestId(),
        payload: {
          namespace,
          operations: operations.map((operation) =>
            operation.op === 'set'
              ? { op: 'set', path: [...operation.path], value: operation.value }
              : { op: 'unset', path: [...operation.path] },
          ),
          expectedRevision,
        },
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
      const target = capturePresetSessionTarget()
      const generation = ++presetRosterGeneration
      const roster = parsePresetRoster(
        await client.request<unknown>({ type: 'preset.list', requestId: requestId() }),
      )
      if (roster === undefined || generation !== presetRosterGeneration) return roster
      const hostDefaultPreset = roster.presets.find((preset) => preset.isDefault)?.id
      setState((current) => {
        const presets = arraysEqual(current.presets, roster.presets) ? current.presets : roster.presets
        if (presets === current.presets && current.presetSelectionEnabled === roster.modeSelectionEnabled)
          return current
        return withPresetSelectionEnabled({ ...current, presets }, roster.modeSelectionEnabled)
      })
      if (target !== undefined && hostDefaultPreset !== undefined)
        await synchronizeBlankSessionPreset(target, hostDefaultPreset)
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
      if (ledgerRebuildTimer !== undefined) {
        window.clearTimeout(ledgerRebuildTimer)
        ledgerRebuildTimer = undefined
      }
      // In-flight opens, rebuilds and gap backfills all guard on openVersion;
      // bumping it retires them without letting a late continuation touch a
      // disposed store. Gap backfills also read `disposed`: they outlive a
      // superseded open on purpose so their announced range is not lost.
      disposed = true
      for (const watcher of [...sessionTurnWatchers]) watcher.dispose()
      pluginInstallRecovery.dispose()
      openVersion += 1
      sessionModelDirectoryGeneration += 1
      accountActions.invalidate()
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
