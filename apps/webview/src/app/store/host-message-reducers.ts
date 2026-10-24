import type {
  AgentConfiguration,
  BackendEvent,
  SessionConfigurationPatch,
  SessionSummary,
} from '@dsh-vscode/domain'
import { CONNECTION_PHASES } from '@dsh-vscode/domain'
import {
  connectionOutputSchema,
  transcriptPatchSchema,
  type HostMessage,
  type TranscriptPatch,
} from '@dsh-vscode/webview-protocol'
import { translate } from '../../i18n.js'
import { parseHostDomainEvent, isSurfaceEventName } from './event-parser.js'
import { parseDshUpdateProgress } from './host-settings.js'
import { EMPTY_SUBAGENT_CATALOG } from './initial-state.js'
import { reduceJobFollow } from './job-follow.js'
import { confirmPendingPrompts } from './pending-prompts.js'
import {
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
import type { AppState, StateSetter } from './types.js'
import { object } from './unknown-record.js'
import { currentTodos } from './todo-state.js'
import { withAvailableList } from './list-availability.js'
import { installTranscript, installTranscriptPatch, parseTranscript } from './transcript-state.js'

export function applyHostMessage(
  message: HostMessage,
  state: AppState,
  setState: StateSetter,
  parsedEvent?: BackendEvent | null,
  projectionSequences?: ProjectionSequenceIndex,
  onConnectionEpoch?: () => void,
): void {
  if (message.type !== 'event') return
  if (message.name === 'session.transcript.patch') {
    try {
      setState(installTranscriptPatch(state, transcriptPatchSchema.parse(message.payload) as TranscriptPatch))
    } catch {
      // A lost baseline is repaired by reading the Host's current window,
      // never by sorting or replaying patches in the renderer.
      if (object(message.payload)?.sessionId === state.activeSessionId) onConnectionEpoch?.()
    }
    return
  }
  if (message.name === 'session.transcript') {
    try {
      setState(installTranscript(state, parseTranscript(message.payload)))
    } catch {
      // A malformed full window needs the same authoritative recovery as a bad patch.
      if (object(message.payload)?.sessionId === state.activeSessionId) onConnectionEpoch?.()
    }
    return
  }
  if (message.name === 'runtime.update.progress') {
    const progress = parseDshUpdateProgress(message.payload)
    if (progress !== undefined) {
      const snapshot = progress.snapshot
      const currentVersion = state.connectedDshVersion ?? snapshot?.currentVersion
      setState({
        ...state,
        dshUpdateProgress: progress,
        ...(snapshot === undefined
          ? progress.phase === 'failed'
            ? { dshUpdate: undefined }
            : {}
          : {
              dshUpdate: {
                ...snapshot,
                ...(currentVersion === undefined ? {} : { currentVersion }),
                restartRequired:
                  currentVersion !== undefined &&
                  snapshot.globalVersion !== undefined &&
                  currentVersion !== snapshot.globalVersion,
              },
            }),
      })
    }
    return
  }
  if (message.name === 'connection.output') {
    const output = connectionOutputSchema.safeParse(message.payload)
    if (output.success) setState({ ...state, connectionOutput: output.data })
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
  // Surface identity and handoff are Host-owned UI control frames with store
  // side effects (the bound-session open, the open-in-editor request). They are
  // applied by the surface actions and must never reach the timeline.
  if (isSurfaceEventName(message.name)) return
  if (message.name === 'connection.snapshot') {
    const snapshot = object(message.payload)
    const output = connectionOutputSchema.safeParse(snapshot?.output)
    if (output.success) state = { ...state, connectionOutput: output.data }
    const kind = snapshot?.kind
    const phase = CONNECTION_PHASES.find((value) => value === snapshot?.phase)
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
        blankSessionReuse: false,
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
          blankSessionReuse: false,
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
          blankSessionReuse: false,
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
          backend: {
            kind,
            ...((kind === 'discovering' || kind === 'connecting') && phase !== undefined ? { phase } : {}),
          },
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
          ...(kind === 'connected' && typeof snapshot?.dshVersion === 'string' && base.dshUpdate !== undefined
            ? {
                dshUpdate: {
                  ...base.dshUpdate,
                  currentVersion: snapshot.dshVersion,
                  restartRequired:
                    base.dshUpdate.globalVersion !== undefined &&
                    base.dshUpdate.globalVersion !== snapshot.dshVersion,
                },
              }
            : {}),
          sessionRestore: kind === 'connected' && snapshot?.sessionRestore === true,
          blankSessionReuse: kind === 'connected' && snapshot?.blankSessionReuse === true,
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
  const event = parsedEvent === undefined ? parseHostDomainEvent(message) : parsedEvent
  if (event === undefined || event === null) return
  // Transcript bodies are installed only through the Host window protocol.
  let next = state
  if (event.type === 'session.status' || event.type === 'turn.started' || event.type === 'turn.ended') {
    if (
      event.type !== 'session.status' &&
      event.sessionId === next.activeSessionId &&
      next.timeline.activeTurn !== undefined &&
      event.turn < next.timeline.activeTurn
    )
      return
    // A durable Turn end is an explicit upstream boundary, unlike an assistant
    // step completion. It settles busy UI if the runtime notification is missed.
    const status =
      event.type === 'session.status'
        ? sessionStatus(event.status)
        : event.type === 'turn.started'
          ? 'running'
          : 'idle'
    const activity: 'running' | 'inactive' = status === 'running' ? 'running' : 'inactive'
    const sessions = updateSessionById(next.sessions, event.sessionId, (session) => {
      // Even a repeated idle notification fences an older in-flight list.
      // Retain its receipt as a new summary identity for the read barrier.
      return {
        ...session,
        status,
        ...(status === 'running' ? { blank: false } : {}),
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
    const hadCurrentTodos =
      next.activeSessionId !== undefined &&
      Object.hasOwn(next.projections[next.activeSessionId] ?? {}, 'todoList')
    let projections = setSessionProjectionBaseline(event.projections, projectionSequences)
    if (
      hadCurrentTodos &&
      next.activeSessionId !== undefined &&
      !Object.hasOwn(projections[next.activeSessionId] ?? {}, 'todoList')
    )
      projections = {
        ...projections,
        [next.activeSessionId]: { ...(projections[next.activeSessionId] ?? {}), todoList: null },
      }
    if (projections !== next.projections) next = { ...next, projections }
    if (
      hadCurrentTodos &&
      next.activeSessionId !== undefined &&
      !Object.hasOwn(event.projections[next.activeSessionId]?.values ?? {}, 'todoList')
    )
      next = { ...next, todos: [] }
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
    if (event.sessionId === next.activeSessionId && event.controlBaseline !== false)
      next = withAvailableList(withAvailableList(next, 'queue'), 'jobs')
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
    if (event.projection !== undefined && event.sessionId === next.activeSessionId) {
      const todos = currentTodos(next.projections[event.sessionId], next.transcript)
      if (!sameTodoList(next.todos, todos)) next = { ...next, todos }
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
      if (event.sessionId === next.activeSessionId) {
        next = withAvailableList(next, 'queue')
        if (!sameQueuedInputList(next.queue, event.items)) next = { ...next, queue: event.items }
      }
      if (next.pendingPrompts !== undefined) {
        const remaining = confirmPendingPrompts(next.pendingPrompts, event.items)
        if (remaining !== undefined) next = { ...next, pendingPrompts: remaining }
      }
    }
  } else if (event.type === 'goal.updated' && event.sessionId === next.activeSessionId) {
    next = withAvailableList(next, 'goals')
    if (!sameGoalList(next.goals, event.goals)) next = { ...next, goals: event.goals }
  } else if (event.type === 'jobs.updated' && event.sessionId === next.activeSessionId) {
    next = withAvailableList(next, 'jobs')
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
      blankSessionReuse: false,
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
    timeline: {
      ...state.timeline,
      nodes: state.timeline.nodes.filter(
        (node) => node.kind !== 'tool' || node.tool.preparation === undefined,
      ),
    },
    sessionDirectoryStatus: 'loading',
    directPromptReceipts: [],
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

export function applyBufferedHostState(
  state: AppState,
  messages: readonly HostMessage[],
  projectionSequences?: ProjectionSequenceIndex,
): AppState {
  let buffered = state
  const setReplayed: StateSetter = (next) => {
    buffered = typeof next === 'function' ? next(buffered) : next
  }
  for (const message of messages)
    applyHostMessage(message, buffered, setReplayed, undefined, projectionSequences)
  return buffered
}

export function backendEventSessionId(event: BackendEvent): string | undefined {
  if ('sessionId' in event && typeof event.sessionId === 'string') return event.sessionId
  if ('request' in event && typeof event.request.sessionId === 'string') return event.request.sessionId
  if ('question' in event && typeof event.question.sessionId === 'string') return event.question.sessionId
  if ('retry' in event && typeof event.retry.sessionId === 'string') return event.retry.sessionId
  return undefined
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
