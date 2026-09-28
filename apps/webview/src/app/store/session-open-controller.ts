import { translate } from '../../i18n.js'
import type { GoalView, JobView, QueuedInput, SubagentCatalog, SubagentView } from '@dsh-vscode/domain'
import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import { createDefaultConfiguration, isAgentConfiguration } from './model-catalog.js'
import { promptModeForConfiguration } from './agent-config.js'
import {
  loadSessionModelDirectory,
  mergeSessionModelDirectory,
  type CommandDirectoryCache,
} from './command-directory.js'
import { isGoalView, isJobView, isQueuedInput, nonEmptyString } from './event-values.js'
import { feedbackRecord } from './feature-parsers.js'
import {
  hydrateTimelineFromEntries,
  hydrateTimelineFromHistoryEvents,
  optionalSequence,
  parseSessionHistoryWithTimeline,
} from './history-replay.js'
import { oldestHistorySequence } from './history-ledger.js'
import { replayHostMessages, latestTodos } from './host-message-reducers.js'
import { EMPTY_SUBAGENT_CATALOG, type ComposerPreferences } from './initial-state.js'
import { stringList } from './list-equality.js'
import { isSessionOpenDetail } from './session-guards.js'
import {
  setSessionProjection,
  upsertOpenedSession,
  type ProjectionSequenceIndex,
} from './session-projection.js'
import { parseSubagentHistory } from './subagent.js'
import { safeList } from './session-registry.js'
import { object } from './unknown-record.js'
import type { AppState, StateSetter } from './types.js'
import type { PendingOpenBuffer } from './pending-open.js'
import type { createFeatureActions } from './feature-actions.js'
import type { createJobActions } from './job-actions.js'
import type { createGapHealing } from './gap-heal.js'
import type { createFeedbackCache } from './feedback-cache.js'

export type SubagentOpenResolution =
  | { readonly kind: 'subagent'; readonly entry: SubagentView; readonly parentAvailable: boolean }
  | { readonly kind: 'session'; readonly sessionId: string }

export interface SessionOpenHost {
  readonly client: ProtocolClient
  readonly getState: () => AppState
  readonly setState: StateSetter
  readonly getComposerPreferences: () => ComposerPreferences
  readonly projectionSequences: ProjectionSequenceIndex
  readonly pendingOpenBuffer: PendingOpenBuffer
  readonly featureActions: ReturnType<typeof createFeatureActions>
  readonly jobActions: ReturnType<typeof createJobActions>
  readonly gapHealing: ReturnType<typeof createGapHealing>
  readonly feedbackCache: ReturnType<typeof createFeedbackCache>
  readonly commandDirectory: CommandDirectoryCache
  readonly requestSessionOpen: (sessionId: string, version: number) => Promise<unknown>
  readonly resolveSubagentOpen: (sessionId: string) => Promise<SubagentOpenResolution>
  readonly loadCommandDirectory: CommandDirectoryCache['load']
  readonly loadSubagentCatalog: (sessionId: string) => Promise<SubagentCatalog | undefined>
  readonly sessionWorkspaceFolderId: (sessionId: string) => string | undefined
  readonly persistWebviewState: (overrides: { readonly activeSessionId?: string }) => void
  readonly flushPendingHistory: () => void
  readonly nextOpenIntent: () => number
  readonly getOpenIntent: () => number
  readonly nextOpenVersion: () => number
  readonly getOpenVersion: () => number
  readonly nextSessionModelDirectoryGeneration: () => number
  readonly getSessionModelDirectoryGeneration: () => number
  readonly getGoalReadGeneration: () => number
  readonly setGoalActivationAvailable: () => void
  readonly clearStartupRestorePending: () => void
}

export function createSessionOpenController(host: SessionOpenHost): {
  readonly open: (requestedSessionId: string, options?: { readonly startup?: boolean }) => Promise<void>
  readonly openSubagent: (entry: SubagentView, parentAvailable: boolean) => Promise<void>
} {
  const {
    client,
    getState,
    setState,
    getComposerPreferences,
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
  } = host
  const { restoreHostOnlyNodes, restoreGapNotices, scheduleGapBackfill, rememberHostOnlyNodes } = gapHealing
  const { requestFeedbackSnapshot } = feedbackCache
  const open = async (
    requestedSessionId: string,
    options: { readonly startup?: boolean } = {},
  ): Promise<void> => {
    let sessionId = requestedSessionId
    // Claims the intent slot before any await. A root open stays fully
    // synchronous up to its buffer registration, or an event delivered while
    // the open is in flight lands outside the replay barrier; only a subagent
    // child pays the catalog read, and that read can be superseded.
    const intent = host.nextOpenIntent()
    if (
      getState().sessions.some(
        (session) => session.id === requestedSessionId && session.origin === 'subagent',
      )
    ) {
      const resolution = await resolveSubagentOpen(requestedSessionId)
      if (intent !== host.getOpenIntent()) return
      if (resolution.kind === 'subagent') {
        await openSubagent(resolution.entry, resolution.parentAvailable)
        return
      }
      sessionId = resolution.sessionId
    }
    jobActions.stopBeforeSessionOpen()
    if (options.startup !== true) host.clearStartupRestorePending()
    flushPendingHistory()
    const version = host.nextOpenVersion()
    const modelDirectoryGeneration = host.nextSessionModelDirectoryGeneration()
    feedbackCache.forget(sessionId)
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
        if (version !== host.getOpenVersion()) return
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
      const goalBaselineGeneration = host.getGoalReadGeneration()
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
      if (version !== host.getOpenVersion()) return
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
                  ...createDefaultConfiguration(current, getComposerPreferences()),
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
            commands: commandDirectory.peek(sessionId) ?? [],
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
          if (version !== host.getOpenVersion() || commands === undefined) return
          setState((current) =>
            current.activeSessionId === sessionId && current.commands !== commands
              ? { ...current, commands }
              : current,
          )
        })
        .catch(() => undefined)
      void sessionModelDirectoryData.then((read) => {
        if (
          version !== host.getOpenVersion() ||
          modelDirectoryGeneration !== host.getSessionModelDirectoryGeneration()
        )
          return
        setState((current) =>
          version === host.getOpenVersion() &&
          modelDirectoryGeneration === host.getSessionModelDirectoryGeneration()
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
          if (version !== host.getOpenVersion()) return
          if (
            goalBaselineGeneration === host.getGoalReadGeneration() &&
            goals?.some((goal) => goal.activation !== undefined)
          )
            host.setGoalActivationAvailable()
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
                ...(goals === undefined || goalBaselineGeneration !== host.getGoalReadGeneration()
                  ? {}
                  : { goals }),
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
          pendingOpenBuffer.settle(pending, version === host.getOpenVersion())
        })
      completed = true
    } finally {
      if (!advisoryPending) pendingOpenBuffer.settle(pending, completed)
    }
  }
  const openSubagent = async (entry: SubagentView, parentAvailable: boolean): Promise<void> => {
    // A direct child open (drawer, task row) also supersedes an in-flight
    // by-id resolution inside `open`.
    host.nextOpenIntent()
    jobActions.stopBeforeSessionOpen()
    flushPendingHistory()
    const version = host.nextOpenVersion()
    feedbackCache.forget(entry.id)
    featureActions.retirePromptTemplatesForSubagentSwitch()
    const pending = pendingOpenBuffer.create(entry.id, version)
    // The history and advisory reads overlap. Preserve every event delivered
    // after this open began for the final advisory replay.
    const advisoryReplayStart = pending.messages.length
    let completed = false
    const workspaceId =
      getState().sessions.find((session) => session.id === getState().activeSessionId)?.workspaceId ??
      getState().activeSubagent?.workspaceId ??
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
      const goalBaselineGeneration = host.getGoalReadGeneration()
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
      if (version !== host.getOpenVersion()) return
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
        version === host.getOpenVersion() &&
        goalBaselineGeneration === host.getGoalReadGeneration() &&
        goals?.some((goal) => goal.activation !== undefined)
      )
        host.setGoalActivationAvailable()
      if (version !== host.getOpenVersion()) return
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
            ...(goals === undefined || goalBaselineGeneration !== host.getGoalReadGeneration()
              ? {}
              : { goals }),
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
  return { open, openSubagent }
}
