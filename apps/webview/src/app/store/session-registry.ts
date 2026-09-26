import type { MessageFeedbackItem, SessionSummary, WorkspaceSummary } from '@dsh-vscode/domain'
import type { WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from '../protocol-client.js'
import { parsePresetRoster } from './agent-config.js'
import { isMessageFeedbackItem } from './feature-parsers.js'
import { requestId } from './ids.js'
import { EMPTY_SUBAGENT_CATALOG } from './initial-state.js'
import {
  deduplicateSessionSummaries,
  listValues,
  mergeUniqueStrings,
  sameModelDescriptorList,
  sameModelProviderList,
  samePresetDescriptorList,
  sameSessionSummaryList,
  sameWorkspaceSummaryList,
  strictListValues,
  stringList,
} from './list-equality.js'
import { isModelDescriptor, isModelProvider } from './model-catalog.js'
import { isSessionSummary, isWorkspaceSummary } from './session-guards.js'
import { withPresetSelectionEnabled } from './host-message-reducers.js'
import type { StateSetter } from './types.js'
import { object } from './unknown-record.js'

export async function refreshSessions(
  client: ProtocolClient,
  setState: StateSetter,
  isCurrent: () => boolean = () => true,
  awaitCatalogs = true,
): Promise<void> {
  if (isCurrent())
    setState((current) =>
      current.sessionDirectoryStatus === 'ready'
        ? current
        : { ...current, sessionDirectoryStatus: 'loading' },
    )
  const criticalResults = Promise.allSettled([
    client.request<unknown>({
      type: 'session.list',
      requestId: requestId(),
      payload: { archived: false },
    }),
    client.request<unknown>({ type: 'workspace.list', requestId: requestId() }),
  ])
  const catalogResults = Promise.allSettled([
    client.request<unknown>({ type: 'providers.list', requestId: requestId() }),
    client.request<unknown>({ type: 'models.list', requestId: requestId(), payload: {} }),
    client.request<unknown>({ type: 'preset.list', requestId: requestId() }),
  ])
  const [sessionResult, workspaceResult] = await criticalResults
  const value = (result: PromiseSettledResult<unknown>): unknown =>
    result.status === 'fulfilled' ? result.value : undefined
  const sessionItems = object(value(sessionResult))?.items
  const workspacePayload = object(value(workspaceResult))
  const archivedFromHost = stringList(workspacePayload?.archivedSessionIds)
  const rawSessions = strictListValues(sessionItems, isSessionSummary)
  const rawWorkspaces =
    workspaceResult.status === 'fulfilled'
      ? strictListValues(value(workspaceResult), isWorkspaceSummary)
      : undefined
  if (!isCurrent()) return
  const sessionDirectoryStatus = rawSessions === undefined || rawWorkspaces === undefined ? 'error' : 'ready'
  setState((current) => {
    // Keep local archive knowledge monotonic while the host publishes the
    // archive-set echo. This prevents a stale concurrent session.list from
    // reintroducing the row that was just archived.
    const archivedSessionIds = mergeUniqueStrings(current.archivedSessionIds, archivedFromHost ?? [])
    const archived = new Set(archivedSessionIds)
    const sessions =
      rawSessions === undefined
        ? undefined
        : deduplicateSessionSummaries(rawSessions.filter((session) => !archived.has(session.id)))
    const listedSessions =
      sessions ?? deduplicateSessionSummaries(current.sessions.filter((session) => !archived.has(session.id)))
    // A DSH workspace attach and its session.list projection can commit in
    // adjacent turns. Do not discard the active conversation merely because a
    // refresh observed that short window without its row. The authoritative
    // archive set is the only refresh result that is allowed to remove it.
    const activeSession =
      current.activeSessionId === undefined
        ? undefined
        : current.sessions.find((session) => session.id === current.activeSessionId)
    const nextSessions = deduplicateSessionSummaries(
      activeSession !== undefined &&
        !archived.has(activeSession.id) &&
        !listedSessions.some((session) => session.id === activeSession.id)
        ? [...listedSessions, activeSession]
        : listedSessions,
    )
    const stableSessions = sameSessionSummaryList(current.sessions, nextSessions)
      ? current.sessions
      : nextSessions
    const stableWorkspaces =
      rawWorkspaces === undefined
        ? current.workspaces
        : sameWorkspaceSummaryList(current.workspaces, rawWorkspaces)
          ? current.workspaces
          : rawWorkspaces
    const activeSessionIsArchived =
      current.activeSessionId !== undefined && archived.has(current.activeSessionId)
    const hasVisibilitySnapshot = rawSessions !== undefined || archivedFromHost !== undefined
    if (
      stableSessions === current.sessions &&
      current.sessionDirectoryStatus === sessionDirectoryStatus &&
      archivedSessionIds === current.archivedSessionIds &&
      stableWorkspaces === current.workspaces &&
      !(hasVisibilitySnapshot && activeSessionIsArchived)
    )
      return current
    return {
      ...current,
      sessions: stableSessions,
      sessionDirectoryStatus,
      archivedSessionIds,
      // A transient workspace.list failure must not turn a known temporary
      // workspace into an apparently successful empty snapshot. The host is
      // responsible for creating/restoring the no-folder workspace; retaining
      // the last good value keeps the UI stable until that retry succeeds.
      workspaces: stableWorkspaces,
      ...(hasVisibilitySnapshot && activeSessionIsArchived
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
            projections: {},
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
  })
  const applyCatalogs = (results: readonly PromiseSettledResult<unknown>[]): void => {
    if (!isCurrent()) return
    const catalogValue = (index: number): unknown => {
      const result = results[index]
      return result?.status === 'fulfilled' ? result.value : undefined
    }
    const providers = listValues(catalogValue(0)).filter(isModelProvider)
    const models = strictListValues(catalogValue(1), isModelDescriptor)
    const presetRoster = parsePresetRoster(catalogValue(2))
    const presets = presetRoster?.presets
    setState((current) => {
      const nextProviders =
        providers === undefined || sameModelProviderList(current.providers, providers)
          ? current.providers
          : providers
      const nextModels =
        models === undefined || sameModelDescriptorList(current.models, models) ? current.models : models
      const nextPresets =
        presets === undefined || samePresetDescriptorList(current.presets, presets)
          ? current.presets
          : presets
      const nextPresetSelectionEnabled =
        presetRoster === undefined ? current.presetSelectionEnabled : presetRoster.modeSelectionEnabled
      if (
        nextProviders === current.providers &&
        nextModels === current.models &&
        nextPresets === current.presets &&
        nextPresetSelectionEnabled === current.presetSelectionEnabled
      )
        return current
      return withPresetSelectionEnabled(
        {
          ...current,
          providers: nextProviders,
          models: nextModels,
          presets: nextPresets,
        },
        nextPresetSelectionEnabled,
      )
    })
  }
  if (awaitCatalogs) applyCatalogs(await catalogResults)
  else void catalogResults.then(applyCatalogs)
}

/**
 * Restore the last explicit session when possible. A fresh Webview can lose
 * its persisted id while the DSH session registry is already populated, so
 * fall back to the most recent active root session and then the most recent
 * non-blank root session instead of presenting a misleading "new session"
 * posture. The workspace membership list is also an intentional fallback:
 * during an attach, workspace.list can know a durable session before the
 * session.list projection includes its summary.
 */
export function selectStartupSessionId(
  sessions: readonly SessionSummary[],
  workspaces: readonly WorkspaceSummary[],
  archivedSessionIds: readonly string[],
  rememberedSessionId: string | undefined,
): string | undefined {
  const archived = new Set(archivedSessionIds)
  const workspaceSessionIds = workspaces
    .flatMap((workspace) => workspace.sessionIds ?? [])
    .filter((sessionId, index, all) => !archived.has(sessionId) && all.indexOf(sessionId) === index)
  const remembered =
    rememberedSessionId === undefined
      ? undefined
      : sessions.some((session) => session.id === rememberedSessionId) ||
          workspaceSessionIds.includes(rememberedSessionId)
        ? rememberedSessionId
        : undefined
  if (remembered !== undefined) return remembered

  const rootSessions = sessions
    .filter((session) => session.origin !== 'subagent' && !archived.has(session.id))
    .sort((left, right) => sessionRecency(right) - sessionRecency(left))
  const nonBlankRootSessions = rootSessions.filter((session) => !session.blank)
  const selected =
    nonBlankRootSessions.find(
      (session) => session.status === 'running' || session.status === 'awaiting-input',
    ) ??
    nonBlankRootSessions[0] ??
    rootSessions[0]
  if (selected !== undefined) return selected.id

  // sessionIds is the only durable membership evidence available when the
  // summary projection is temporarily empty. Do not synthesize a SessionSummary;
  // session.open will fetch the authoritative detail from DSH.
  return workspaceSessionIds[0]
}

export function findReusableBlankSession(
  sessions: readonly SessionSummary[],
  archivedSessionIds: readonly string[],
  workspace: WorkspaceSummary,
): SessionSummary | undefined {
  const archived = new Set(archivedSessionIds)
  return sessions.find(
    (session) =>
      session.origin !== 'subagent' &&
      session.blank &&
      !archived.has(session.id) &&
      (workspace.sessionIds?.includes(session.id) === true || session.workspaceId === workspace.id),
  )
}

export function sessionRecency(session: SessionSummary): number {
  const timestamp = Date.parse(session.updatedAt)
  return Number.isFinite(timestamp) ? timestamp : 0
}

export async function safeList<T>(
  client: ProtocolClient,
  request: WebviewRequest,
  guard: (value: unknown) => value is T,
): Promise<readonly T[] | undefined> {
  try {
    const result = await client.request<unknown>(request)
    return strictListValues(result, guard)
  } catch {
    return undefined
  }
}

export interface FeedbackListResult {
  readonly items: readonly MessageFeedbackItem[] | undefined
  readonly unavailable: boolean | undefined
}

export async function safeFeedbackList(
  client: ProtocolClient,
  sessionId: string,
): Promise<FeedbackListResult> {
  try {
    const result = await client.request<unknown>({
      type: 'feedback.list',
      requestId: requestId(),
      payload: { sessionId },
    })
    const items = strictListValues(result, isMessageFeedbackItem)
    return items === undefined ? { items: undefined, unavailable: undefined } : { items, unavailable: false }
  } catch (error) {
    return {
      items: undefined,
      unavailable: isFeedbackCapabilityUnavailable(error) ? true : undefined,
    }
  }
}

export function isFeedbackCapabilityUnavailable(error: unknown): boolean {
  return object(error)?.code === 'CAPABILITY_UNAVAILABLE'
}
