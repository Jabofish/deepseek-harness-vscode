import type { SessionProjectionSnapshot, SessionSummary } from '@dsh-vscode/domain'
import { nonEmptyString, projectionAsOfSequence } from './event-values.js'
import { EMPTY_SUBAGENT_CATALOG } from './initial-state.js'
import { optionalGeneration } from './scalars.js'
import { isSessionSummary } from './session-guards.js'
import type { AppState } from './types.js'
import { object } from './unknown-record.js'
import { currentTodos } from './todo-state.js'
import { sameTodoList } from './list-equality.js'

export interface ProjectionSequenceIndex {
  readonly perKey: Map<string, Map<string, number>>
  readonly baselines: Map<string, number>
  readonly queueBySession: Map<string, number>
  connectionIdentity: string | undefined
}

export function upsertOpenedSession(
  sessions: readonly SessionSummary[],
  detail: Record<string, unknown> | undefined,
  sessionId: string,
): readonly SessionSummary[] {
  const opened = isSessionSummary(detail) ? detail : undefined
  if (opened === undefined) return sessions
  const withoutOpened = sessions.filter((session) => session.id !== sessionId)
  // A detail also carries history/configuration/view data. Never retain that
  // object in the roster after switching sessions.
  const summary: SessionSummary = {
    id: opened.id,
    workspaceId: opened.workspaceId,
    title: opened.title,
    blank: opened.blank,
    status: opened.status,
    createdAt: opened.createdAt,
    updatedAt: opened.updatedAt,
    ...(opened.cwd === undefined ? {} : { cwd: opened.cwd }),
    ...(opened.workspaceFolderId === undefined ? {} : { workspaceFolderId: opened.workspaceFolderId }),
    ...(opened.parentSessionId === undefined ? {} : { parentSessionId: opened.parentSessionId }),
    ...(opened.origin === undefined ? {} : { origin: opened.origin }),
    ...(opened.formatStatus === undefined ? {} : { formatStatus: opened.formatStatus }),
    ...(opened.agentAvailable === undefined ? {} : { agentAvailable: opened.agentAvailable }),
    ...(opened.modelLabel === undefined ? {} : { modelLabel: opened.modelLabel }),
    ...(opened.agentPreset === undefined ? {} : { agentPreset: opened.agentPreset }),
  }
  return [...withoutOpened, summary]
}

export function updateSessionById(
  sessions: readonly SessionSummary[],
  sessionId: string,
  update: (session: SessionSummary) => SessionSummary,
): readonly SessionSummary[] {
  const index = sessions.findIndex((session) => session.id === sessionId)
  if (index < 0) return sessions
  const updated = update(sessions[index]!)
  if (updated === sessions[index]) return sessions
  const next = [...sessions]
  next[index] = updated
  return next
}

export function setSessionProjection(
  projections: AppState['projections'],
  sessionId: string,
  projection: unknown,
  projectionSequences?: ProjectionSequenceIndex,
): AppState['projections'] {
  const record = object(projection)
  const values = object(record?.values)
  if (values === undefined) return projections
  const sequence = projectionAsOfSequence(record?.asOfSequence)
  // Older adapters did not expose a projection cut. Preserve their historical
  // whole-snapshot behavior; versioned Alpha/rc.6 payloads always carry one and
  // use the per-key higher-sequence path below.
  if (sequence === undefined) return { ...projections, [sessionId]: values }

  const current = projections[sessionId]
  const next = { ...(current ?? {}) }
  const previousBaseline = projectionSequences?.baselines.get(sessionId)
  if (previousBaseline !== undefined && sequence <= previousBaseline) return projections
  if (projectionSequences !== undefined) projectionSequences.baselines.set(sessionId, sequence)
  let changed = false
  for (const [key, value] of Object.entries(values)) {
    const previous = projectionSequences?.perKey.get(sessionId)?.get(key)
    if (previous !== undefined && sequence <= previous) continue
    if (projectionSequences !== undefined) {
      const perSession = projectionSequences.perKey.get(sessionId) ?? new Map<string, number>()
      perSession.set(key, sequence)
      projectionSequences.perKey.set(sessionId, perSession)
    }
    if (current === undefined || !Object.hasOwn(current, key) || !Object.is(current[key], value)) {
      next[key] = value
      changed = true
    }
  }
  // A complete baseline also carries absence information. Keep a tombstone
  // watermark for an omitted key so a delayed lower-sequence frame cannot
  // resurrect a value that the newer snapshot has removed.
  const knownKeys = new Set([
    ...Object.keys(current ?? {}),
    ...(projectionSequences?.perKey.get(sessionId)?.keys() ?? []),
  ])
  for (const key of knownKeys) {
    if (Object.hasOwn(values, key)) continue
    const previous = projectionSequences?.perKey.get(sessionId)?.get(key)
    if (previous !== undefined && sequence <= previous) continue
    if (projectionSequences !== undefined) {
      const perSession = projectionSequences.perKey.get(sessionId) ?? new Map<string, number>()
      perSession.set(key, sequence)
      projectionSequences.perKey.set(sessionId, perSession)
    }
    delete next[key]
    changed = true
  }
  return changed ? { ...projections, [sessionId]: next } : projections
}

export function setSessionProjectionBaseline(
  baseline: Readonly<Record<string, SessionProjectionSnapshot>>,
  projectionSequences?: ProjectionSequenceIndex,
): AppState['projections'] {
  const projections = Object.fromEntries(
    Object.entries(baseline).map(([sessionId, projection]) => [sessionId, projection.values]),
  )
  projectionSequences?.perKey.clear()
  projectionSequences?.baselines.clear()
  for (const [sessionId, projection] of Object.entries(baseline)) {
    projectionSequences?.baselines.set(sessionId, projection.asOfSequence)
    projectionSequences?.perKey.set(
      sessionId,
      new Map(Object.keys(projection.values).map((key) => [key, projection.asOfSequence])),
    )
  }
  return projections
}

export function applySessionProjectionPresentation(
  current: AppState,
  sessionId: string,
  key: string,
  value: unknown,
): AppState {
  let next = current
  if (sessionId === next.activeSessionId && key === 'todoList') {
    const todos = currentTodos({ todoList: value }, next.transcript)
    if (!sameTodoList(next.todos, todos)) next = { ...next, todos }
  }
  if (sessionId === next.activeSessionId && next.configuration !== undefined) {
    const projection = object(value)
    const configuration = next.configuration
    if (key === 'plan' && typeof projection?.active === 'boolean')
      next = {
        ...next,
        configuration: { ...configuration, planMode: projection.active, planModeKnown: true },
      }
    if (
      key === 'permissions' &&
      typeof projection?.currentValue === 'string' &&
      projection.currentValue.trim() !== ''
    )
      next = {
        ...next,
        configuration: {
          ...configuration,
          permissionPreset: projection.currentValue,
          permissionPresetKnown: true,
        },
      }
  }
  if (key === 'title' && typeof value === 'string') {
    const title = value.trim()
    if (title !== '') {
      const sessions = updateSessionById(next.sessions, sessionId, (session) =>
        !session.blank && session.title !== title ? { ...session, title } : session,
      )
      if (sessions !== next.sessions) next = { ...next, sessions }
    }
  }
  return next
}

export function updateSessionProjection(
  projections: AppState['projections'],
  sessionId: string,
  key: string,
  value: unknown,
  sequence?: number,
  projectionSequences?: ProjectionSequenceIndex,
): AppState['projections'] {
  if (!acceptProjectionSequence(projectionSequences, sessionId, key, sequence)) return projections
  const current = projections[sessionId]
  if (current !== undefined && Object.hasOwn(current, key) && Object.is(current[key], value))
    return projections
  return {
    ...projections,
    [sessionId]: { ...(current ?? {}), [key]: value },
  }
}

export function connectionIdentity(snapshot: Record<string, unknown> | undefined): string | undefined {
  const backendInstanceId = snapshot?.backendInstanceId
  const connectionGeneration = optionalGeneration(snapshot?.connectionGeneration)
  if (!nonEmptyString(backendInstanceId) || connectionGeneration === undefined) return undefined
  return JSON.stringify([backendInstanceId, connectionGeneration])
}

export function acceptProjectionSequence(
  projectionSequences: ProjectionSequenceIndex | undefined,
  sessionId: string,
  key: string,
  sequence: number | undefined,
): boolean {
  if (projectionSequences === undefined || sequence === undefined) return true
  const baseline = projectionSequences.baselines.get(sessionId)
  if (baseline !== undefined && sequence <= baseline) return false
  const perSession = projectionSequences.perKey.get(sessionId) ?? new Map<string, number>()
  const previous = perSession.get(key)
  if (previous !== undefined && sequence <= previous) return false
  perSession.set(key, sequence)
  projectionSequences.perKey.set(sessionId, perSession)
  return true
}

export function currentProjectionSequence(
  projectionSequences: ProjectionSequenceIndex | undefined,
  sessionId: string,
  key: string,
  sequence: number | undefined,
): boolean {
  if (projectionSequences === undefined || sequence === undefined) return true
  const baseline = projectionSequences.baselines.get(sessionId)
  if (baseline !== undefined && sequence <= baseline) return false
  const previous = projectionSequences.perKey.get(sessionId)?.get(key)
  return previous === undefined || sequence > previous
}

export function removeSessionProjection(
  projections: AppState['projections'],
  sessionId: string,
): AppState['projections'] {
  const remaining = { ...projections }
  delete remaining[sessionId]
  return remaining
}

/**
 * Every session-scoped view state describes the conversation that is no
 * longer open: leaving any of it behind would show one session's history,
 * queue, or catalogs under the next row the user opens.
 */
export function clearedActiveSession(current: AppState, sessionId: string): Partial<AppState> {
  return {
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
    projections: removeSessionProjection(current.projections, sessionId),
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
}
