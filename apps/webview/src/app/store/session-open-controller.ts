import { translate } from '../../i18n.js'
import type { GoalView, JobView, QueuedInput, SubagentCatalog, SubagentView } from '@dsh-vscode/domain'
import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import { createDefaultConfiguration, isAgentConfiguration } from './model-catalog.js'
import { promptModeForConfiguration } from './agent-config.js'
import { loadSessionModelDirectory, mergeSessionModelDirectory } from './session-model-directory.js'
import type { CommandDirectoryCache } from './command-directory.js'
import { isGoalView, isJobView, isQueuedInput, nonEmptyString } from './event-values.js'
import { feedbackRecord } from './feature-parsers.js'
import { applyBufferedHostState } from './host-message-reducers.js'
import { withCurrentTodos } from './todo-state.js'
import { parseTranscript, reconcileFullWindow, transcriptTimeline } from './transcript-state.js'
import { EMPTY_SUBAGENT_CATALOG, type ComposerPreferences } from './initial-state.js'
import { stringList } from './list-equality.js'
import { isSessionOpenDetail } from './session-guards.js'
import {
  setSessionProjection,
  upsertOpenedSession,
  type ProjectionSequenceIndex,
} from './session-projection.js'
import { parseSubagentHistory } from './subagent.js'
import { safeList, type FeedbackListResult } from './session-registry.js'
import { object } from './unknown-record.js'
import type { AppState, StateSetter } from './types.js'
import type { PendingOpenBuffer, PendingSessionOpen } from './opening-state.js'
import type { createFeatureActions } from './feature-actions.js'
import type { createJobActions } from './job-actions.js'
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
  readonly feedbackCache: ReturnType<typeof createFeedbackCache>
  readonly commandDirectory: CommandDirectoryCache
  readonly requestSessionOpen: (sessionId: string, version: number) => Promise<unknown>
  readonly resolveSubagentOpen: (sessionId: string) => Promise<SubagentOpenResolution>
  readonly loadCommandDirectory: CommandDirectoryCache['load']
  readonly loadSubagentCatalog: (sessionId: string) => Promise<SubagentCatalog | undefined>
  readonly sessionWorkspaceFolderId: (sessionId: string) => string | undefined
  readonly persistWebviewState: (overrides: { readonly activeSessionId?: string }) => void
  readonly nextOpenIntent: () => number
  readonly getOpenIntent: () => number
  readonly nextOpenVersion: () => number
  readonly getOpenVersion: () => number
  readonly nextSessionModelDirectoryGeneration: () => number
  readonly getSessionModelDirectoryGeneration: () => number
  readonly getGoalReadGeneration: () => number
  readonly nextQueueReadGeneration: () => number
  readonly getQueueReadGeneration: () => number
  readonly setGoalActivationAvailable: () => void
  readonly clearStartupRestorePending: () => void
}

interface SessionAdvisoryReads {
  readonly goalGeneration: number
  readonly queueGeneration: number
  readonly queue: Promise<readonly QueuedInput[] | undefined>
  readonly goals: Promise<readonly GoalView[] | undefined>
  readonly jobs: Promise<readonly JobView[] | undefined>
  readonly feedback: Promise<FeedbackListResult>
  readonly subagents: Promise<SubagentCatalog | undefined>
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
    feedbackCache,
    commandDirectory,
    requestSessionOpen,
    resolveSubagentOpen,
    loadCommandDirectory,
    loadSubagentCatalog,
    sessionWorkspaceFolderId,
    persistWebviewState,
  } = host
  // A new backend must republish image references so failed thumbnail reads
  // can retry. Share full-open rows only within the connection that installed them.
  let installedTranscriptEpoch: number | undefined
  const { requestFeedbackSnapshot } = feedbackCache
  const readAdvisoryData = (sessionId: string): SessionAdvisoryReads => ({
    goalGeneration: host.getGoalReadGeneration(),
    queueGeneration: host.nextQueueReadGeneration(),
    queue: safeList<QueuedInput>(
      client,
      { type: 'session.queue.list', requestId: requestId(), payload: { sessionId } },
      isQueuedInput,
    ),
    goals: safeList<GoalView>(
      client,
      { type: 'goal.list', requestId: requestId(), payload: { sessionId } },
      isGoalView,
    ),
    jobs: safeList<JobView>(
      client,
      { type: 'job.list', requestId: requestId(), payload: { sessionId } },
      isJobView,
    ),
    feedback: requestFeedbackSnapshot(sessionId),
    subagents: loadSubagentCatalog(sessionId),
  })
  const hydrateAdvisoryData = (pending: PendingSessionOpen, reads: SessionAdvisoryReads): void => {
    const { sessionId, version } = pending
    const isCurrent = (): boolean =>
      version === host.getOpenVersion() && getState().activeSessionId === sessionId
    const mergeList = <K extends 'queue' | 'goals' | 'jobs'>(
      key: K,
      items: AppState[K] | undefined,
      eventNames: readonly string[],
    ): void => {
      if (!isCurrent()) return
      const superseded =
        (key === 'goals' && reads.goalGeneration !== host.getGoalReadGeneration()) ||
        (key === 'queue' && reads.queueGeneration !== host.getQueueReadGeneration())
      setState((current) => {
        if (superseded) return current
        const unavailableLists = [
          ...(current.unavailableLists ?? []).filter((entry) => entry !== key),
          ...(items === undefined ? [key] : []),
        ]
        // Only rebase this surface. Replaying unrelated transcript/projection
        // frames on each completed read would redo work and roll back peers.
        // Queue facts have already advanced the live sequence index, so this
        // local snapshot overlay must not reject their replay as duplicates.
        const replayed = applyBufferedHostState(
          { ...current, ...(items === undefined ? {} : { [key]: items }), unavailableLists },
          pending.messages.filter((message) => message.type === 'event' && eventNames.includes(message.name)),
          {
            perKey: new Map(),
            baselines: new Map(),
            queueBySession: new Map(),
            connectionIdentity: projectionSequences.connectionIdentity,
          },
        )
        return { ...current, [key]: replayed[key], unavailableLists: replayed.unavailableLists ?? [] }
      })
    }
    // Attach after first paint, even for child reads that finished before the
    // history. A slow optional endpoint must not hold any other surface back.
    void Promise.allSettled([
      reads.queue.then((queue) => mergeList('queue', queue, ['queue.updated', 'session.subscribed'])),
      reads.goals.then((goals) => {
        if (
          isCurrent() &&
          reads.goalGeneration === host.getGoalReadGeneration() &&
          goals?.some((goal) => goal.activation !== undefined)
        )
          host.setGoalActivationAvailable()
        mergeList('goals', goals, ['goal.updated'])
      }),
      reads.jobs.then((jobs) => mergeList('jobs', jobs, ['jobs.updated', 'session.subscribed'])),
      reads.feedback.then((feedback) => {
        if (!isCurrent()) return
        setState((current) => ({
          ...current,
          ...(feedback.items === undefined ? {} : { feedback: feedbackRecord(feedback.items) }),
          ...(feedback.unavailable === undefined ? {} : { feedbackUnavailable: feedback.unavailable }),
        }))
      }),
      reads.subagents.then((subagents) => {
        if (!isCurrent() || subagents === undefined) return
        setState((current) => ({ ...current, subagents }))
      }),
    ]).then(() => pendingOpenBuffer.settle(pending, isCurrent()))
    featureActions.refreshSessionScopedStates(sessionId)
  }
  const open = async (
    requestedSessionId: string,
    options: { readonly startup?: boolean } = {},
  ): Promise<void> => {
    let sessionId = requestedSessionId
    // Claims the intent slot before any await. A root open stays fully
    // synchronous up to its buffer registration, or an event delivered while
    // the open is in flight lands outside the opening barrier; only a subagent
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
    const version = host.nextOpenVersion()
    const modelDirectoryGeneration = host.nextSessionModelDirectoryGeneration()
    feedbackCache.forget(sessionId)
    featureActions.retireForSessionSwitch()
    const pending = pendingOpenBuffer.create(sessionId, version)
    // Events delivered after this open began must be replayed after the
    // advisory snapshots, even when the critical Host window request has not
    // produced first paint yet.
    let completed = false
    let advisoryPending = false
    try {
      void featureActions.discardEditorContextForSessionSwitch(sessionId)
      if (version !== host.getOpenVersion()) return
      let result: unknown
      try {
        result = await requestSessionOpen(sessionId, version)
      } catch (reason) {
        // A newer open() owns the panel; a stale failure is irrelevant noise.
        if (version !== host.getOpenVersion()) return
        throw reason
      }
      if (version !== host.getOpenVersion()) return
      const detail = object(result)
      if (!isSessionOpenDetail(detail, sessionId)) throw new Error(translate('app.error.openSession'))
      const transcript = parseTranscript(detail.transcript)
      if (transcript.sessionId !== sessionId) throw new Error(translate('app.error.openSession'))
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
      const secondaryData = readAdvisoryData(sessionId)
      if (version !== host.getOpenVersion()) return
      const initialMessages = pendingOpenBuffer.messagesAfterReplay(pending)
      setState((current) => {
        const reconciled = reconcileFullWindow(
          installedTranscriptEpoch === current.connectionEpoch ? current.transcript : undefined,
          transcript,
        )
        installedTranscriptEpoch = current.connectionEpoch
        return applyBufferedHostState(
          withCurrentTodos({
            ...current,
            activeSessionId: sessionId,
            pendingSession: undefined,
            timeline: transcriptTimeline(reconciled, current.timeline),
            transcript: reconciled,
            historyHasMore: transcript.hasMore,
            historyBeforeSequence: transcript.beforeSequence,
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
            todos: [],
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
          }),
          initialMessages,
          projectionSequences,
        )
      })
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

      hydrateAdvisoryData(pending, secondaryData)
      featureActions.refreshEditorContextForOpen(workspaceFolderId)
      completed = true
    } finally {
      if (!advisoryPending) pendingOpenBuffer.settle(pending, completed)
    }
  }
  const openSubagent = async (entry: SubagentView, parentAvailable: boolean): Promise<void> => {
    if (entry.mode === 'external') throw new Error(translate('subagents.externalUnavailable'))
    // A direct child open (drawer, task row) also supersedes an in-flight
    // by-id resolution inside `open`.
    host.nextOpenIntent()
    jobActions.stopBeforeSessionOpen()
    const version = host.nextOpenVersion()
    feedbackCache.forget(entry.id)
    featureActions.retirePromptTemplatesForSubagentSwitch()
    const pending = pendingOpenBuffer.create(entry.id, version)
    // The history and advisory reads overlap. Preserve every event delivered
    // after this open began for the final control-state merge.
    let completed = false
    let advisoryPending = false
    const workspaceId =
      getState().sessions.find((session) => session.id === getState().activeSessionId)?.workspaceId ??
      getState().activeSubagent?.workspaceId ??
      ''
    try {
      void featureActions.discardEditorContextForSessionSwitch(entry.id)
      if (version !== host.getOpenVersion()) return
      // The child→parent routing is connection state owned by the host
      // catalog: a child transcript can only be read after its parent catalog
      // was read on *this* connection, and a replacement process starts
      // without one. Read it first instead of beside the history request; the
      // caller still owns `parentAvailable`, which it read from that catalog.
      await loadSubagentCatalog(entry.parentSessionId)
      if (version !== host.getOpenVersion()) return
      const historyData = client
        .request<unknown>({
          type: 'subagent.history',
          requestId: requestId(),
          payload: { sessionId: entry.id },
        })
        .then(parseSubagentHistory)
      const secondaryData = readAdvisoryData(entry.id)
      const history = await historyData
      if (version !== host.getOpenVersion()) return
      const transcript = history.transcript
      if (transcript.sessionId !== entry.id) throw new Error(translate('app.error.openSession'))
      const initialMessages = pendingOpenBuffer.messagesAfterReplay(pending)
      setState((current) => {
        const reconciled = reconcileFullWindow(
          installedTranscriptEpoch === current.connectionEpoch ? current.transcript : undefined,
          transcript,
        )
        installedTranscriptEpoch = current.connectionEpoch
        return applyBufferedHostState(
          withCurrentTodos({
            ...current,
            activeSessionId: entry.id,
            pendingSession: undefined,
            activeSubagent: { entry, parentAvailable, workspaceId },
            timeline: transcriptTimeline(reconciled, current.timeline),
            transcript: reconciled,
            historyHasMore: transcript.hasMore,
            historyBeforeSequence: transcript.beforeSequence,
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
            todos: [],
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
          }),
          initialMessages,
          projectionSequences,
        )
      })
      pending.ready = true
      persistWebviewState({ activeSessionId: entry.id })

      advisoryPending = true
      hydrateAdvisoryData(pending, secondaryData)
      completed = true
    } finally {
      if (!advisoryPending) pendingOpenBuffer.settle(pending, completed)
    }
  }
  return { open, openSubagent }
}
