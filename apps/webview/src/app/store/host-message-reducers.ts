import type {
  AgentConfiguration,
  BackendEvent,
  SessionConfigurationPatch,
  SessionHistoryEvent,
  SessionSummary,
  TodoView,
} from '@dsh-vscode/domain'
import type { HostMessage } from '@dsh-vscode/webview-protocol'
import {
  isInjectedUserMessage,
  reduceTimeline,
  type TimelineNode,
  type TimelineState,
} from '@dsh-vscode/timeline'
import { translate } from '../../i18n.js'
import { domainEvent, timelineSequenceOptions } from './event-parser.js'
import { historyTime, hydrateTimelineFromEntries } from './history-replay.js'
import { mergeHistory } from './history-ledger.js'
import { parseDshUpdateProgress } from './host-settings.js'
import { EMPTY_SUBAGENT_CATALOG } from './initial-state.js'
import { reduceJobFollow } from './job-follow.js'
import {
  removeAdmittedQueueInput,
  removeMatching,
  sameGoalList,
  sameJobList,
  sameQueuedInputList,
  sameTodoList,
} from './list-equality.js'
import {
  applySessionProjectionPresentation,
  connectionIdentity,
  currentProjectionSequence,
  removeSessionProjection,
  setSessionProjection,
  setSessionProjectionBaseline,
  updateSessionProjection,
  updateSessionById,
  type ProjectionSequenceIndex,
} from './session-projection.js'
import type { AppState, LiveHistoryAppender, StateSetter } from './types.js'
import { object } from './unknown-record.js'

export function applyHostMessage(
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
    const nextConnectionIdentity = connectionIdentity(snapshot)
    const identityChanged =
      kind === 'connected' &&
      nextConnectionIdentity !== undefined &&
      projectionSequences?.connectionIdentity !== undefined &&
      nextConnectionIdentity !== projectionSequences.connectionIdentity
    const connectionEpochChanged =
      kind === 'connected' && (state.backend.kind !== 'connected' || identityChanged)
    // A manual reconnect publishes stopping/idle before the new connected
    // epoch and may not emit connection.lost. Projection cuts belong to one
    // DSH process epoch, so never let the previous process watermark reject
    // the replacement's lower sequence baseline.
    if (kind !== 'connected') {
      projectionSequences?.perKey.clear()
      projectionSequences?.baselines.clear()
      projectionSequences?.queueBySession.clear()
      if (projectionSequences !== undefined) projectionSequences.connectionIdentity = undefined
    } else if (nextConnectionIdentity !== undefined) {
      if (identityChanged) {
        projectionSequences?.perKey.clear()
        projectionSequences?.baselines.clear()
        projectionSequences?.queueBySession.clear()
      }
      if (projectionSequences !== undefined) projectionSequences.connectionIdentity = nextConnectionIdentity
    }
    // Leaving `connected` means the process that owned the live queue,
    // approvals and catalogs is gone. `connected` -> `connected` is the
    // coordinator's cached-backend fast path, where every surface stays valid.
    const base =
      state.backend.kind === 'connected' && (kind !== 'connected' || identityChanged)
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
        accountLifecycleAvailable: false,
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
          ...base,
          connectedDshVersion: undefined,
          subagentImagePrompts: false,
          sessionRestore: false,
          jobControllerAvailable: false,
          accountLifecycleAvailable: false,
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
          ...base,
          connectedDshVersion: undefined,
          subagentImagePrompts: false,
          sessionRestore: false,
          jobControllerAvailable: false,
          accountLifecycleAvailable: false,
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
          ...base,
          backend: { kind },
          connectionEpoch: connectionEpochChanged
            ? (state.connectionEpoch ?? 0) + 1
            : (base.connectionEpoch ?? 0),
          sessionDirectoryStatus:
            kind === 'connected' && !connectionEpochChanged
              ? (base.sessionDirectoryStatus ?? 'loading')
              : 'loading',
          connectedDshVersion:
            kind === 'connected' && typeof snapshot?.dshVersion === 'string'
              ? snapshot.dshVersion
              : undefined,
          sessionRestore: kind === 'connected' && snapshot?.sessionRestore === true,
          jobControllerAvailable: kind === 'connected' && snapshot?.jobController === true,
          accountLifecycleAvailable: kind === 'connected' && snapshot?.accountLifecycleAvailable === true,
          subagentImagePrompts: kind === 'connected' && snapshot?.subagentImagePrompts === true,
          dshCompatibilityWarning:
            kind === 'connected' && typeof snapshot?.compatibilityWarning === 'string'
              ? snapshot.compatibilityWarning
              : undefined,
        })
      // Every DSH process owns its own follow subscriptions. The replacement
      // process never inherits the previous one's, so the conversation on
      // screen would silently stop receiving model and tool events even
      // though the shell reports a healthy connection.
      if (connectionEpochChanged) onConnectionEpoch?.()
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
    projectionSequences?.queueBySession.delete(event.sessionId)
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
  } else if (event.type === 'queue.updated') {
    const previousSequence = projectionSequences?.queueBySession.get(event.sessionId)
    const hasValidSequence =
      event.asOfSequence === undefined ||
      (Number.isSafeInteger(event.asOfSequence) &&
        event.asOfSequence >= 0 &&
        !Object.is(event.asOfSequence, -0))
    const isStale =
      !hasValidSequence ||
      (previousSequence !== undefined &&
        (event.asOfSequence === undefined || event.asOfSequence <= previousSequence))
    if (!isStale) {
      if (event.asOfSequence !== undefined)
        projectionSequences?.queueBySession.set(event.sessionId, event.asOfSequence)
      if (event.sessionId === next.activeSessionId && !sameQueuedInputList(next.queue, event.items))
        next = { ...next, queue: event.items }
    }
  } else if (event.type === 'goal.updated' && event.sessionId === next.activeSessionId) {
    if (!sameGoalList(next.goals, event.goals)) next = { ...next, goals: event.goals }
  } else if (event.type === 'todo.updated' && event.sessionId === next.activeSessionId) {
    if (!sameTodoList(next.todos, event.todos)) next = { ...next, todos: event.todos }
  } else if (event.type === 'jobs.updated' && event.sessionId === next.activeSessionId) {
    if (!sameJobList(next.jobs, event.jobs)) next = { ...next, jobs: event.jobs }
  } else if (event.type === 'job.follow.updated' && event.sessionId === next.activeSessionId) {
    if (next.jobFollow?.jobId === event.jobId && next.jobFollow.followId === event.followId) {
      const jobFollow = reduceJobFollow(next.jobFollow, event.jobId, event.frame)
      if (jobFollow !== next.jobFollow) next = { ...next, jobFollow }
    }
  } else if (event.type === 'job.follow.failed' && event.sessionId === next.activeSessionId) {
    if (next.jobFollow?.jobId === event.jobId && next.jobFollow.followId === event.followId)
      next = { ...next, jobFollow: { ...next.jobFollow, error: event.reason } }
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
      accountLifecycleAvailable: false,
      dshCompatibilityWarning: undefined,
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
export function withoutConnectionScopedSurfaces(state: AppState): AppState {
  const withoutPresetSelection = withPresetSelectionEnabled(state, undefined)
  return {
    ...withoutPresetSelection,
    sessionDirectoryStatus: 'loading',
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
    accountLifecycleAvailable: false,
    accountLifecycle: null,
    accountLifecycleLoading: false,
    accountLifecycleBusy: false,
    accountLifecycleImpact: undefined,
    accountSessionExpired: false,
    accountLifecycleError: undefined,
    accountLifecycleRequestFailed: false,
    accountProfileDetails: null,
    accountProfileLoading: false,
    accountProfileRequestFailed: false,
  }
}

export function withPresetSelectionEnabled(state: AppState, enabled: boolean | undefined): AppState {
  if (state.presetSelectionEnabled === enabled) return state
  return { ...state, presetSelectionEnabled: enabled }
}

export function replayHostMessages(
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

export function backendEventSessionId(event: BackendEvent): string | undefined {
  if ('sessionId' in event && typeof event.sessionId === 'string') return event.sessionId
  if ('request' in event && typeof event.request.sessionId === 'string') return event.request.sessionId
  if ('question' in event && typeof event.question.sessionId === 'string') return event.question.sessionId
  if ('retry' in event && typeof event.retry.sessionId === 'string') return event.retry.sessionId
  return undefined
}

export function isAssistantDelta(event: BackendEvent): boolean {
  return event.type === 'message.delta' || event.type === 'reasoning.delta'
}

/**
 * Rows only the Extension Host publishes: DSH history never replays them, so
 * any path that rebuilds the transcript from history has to put them back
 * explicitly. Gap warnings are excluded; they are restored from
 * `unhealedGapRanges`, which knows whether the hole was healed by a backfill.
 */
export function isHostOnlyTimelineNode(node: TimelineNode): boolean {
  return node.kind === 'command-input' || (node.kind === 'notice' && !node.id.startsWith('gap:'))
}

/** Position a remembered row behind the nearest of its recorded neighbour rows. */
export function hostOnlyInsertIndex(nodes: readonly TimelineNode[], anchors: readonly string[]): number {
  for (const anchor of anchors) {
    const index = nodes.findIndex((node) => node.id === anchor)
    if (index >= 0) return index + 1
  }
  return nodes.length
}

/** Session/catalog state events do not need a new TimelineState object. */
export function eventMayChangeTimelineState(event: BackendEvent): boolean {
  switch (event.type) {
    case 'archived.sessions.changed':
    case 'jobs.updated':
    case 'job.follow.updated':
    case 'job.follow.failed':
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

export function sessionStatus(value: string): SessionSummary['status'] {
  if (value === 'running') return 'running'
  if (value === 'awaiting-input') return 'awaiting-input'
  if (value === 'failed') return 'failed'
  if (value === 'completed') return 'completed'
  return 'idle'
}

export function laterSessionTimestamp(current: string, candidateMs: number, candidate: string): string {
  const currentMs = Date.parse(current)
  return Number.isFinite(currentMs) && currentMs > candidateMs ? current : candidate
}

export function isCommandMessageSource(source: string | undefined): boolean {
  return source?.toLowerCase().includes('command') === true
}

export function mergeConfigurationPatch(
  configuration: AgentConfiguration,
  patch: SessionConfigurationPatch,
): AgentConfiguration {
  return {
    ...configuration,
    ...patch,
    model: patch.model === undefined ? configuration.model : { ...configuration.model, ...patch.model },
  }
}

export function latestTodos(timeline: TimelineState): readonly TodoView[] {
  for (let index = timeline.nodes.length - 1; index >= 0; index -= 1) {
    const node = timeline.nodes[index]
    if (node?.kind === 'todo') return node.todos
  }
  return []
}
