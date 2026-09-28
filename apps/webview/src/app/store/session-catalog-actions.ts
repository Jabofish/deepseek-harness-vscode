import { translate } from '../../i18n.js'
import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import { strictListValues, deduplicateSessionSummaries, uniqueStrings } from './list-equality.js'
import { isSessionSummary } from './session-guards.js'
import { nextForkTitle } from './subagent.js'
import { clearedActiveSession } from './session-projection.js'
import { object } from './unknown-record.js'
import type { AppActions, AppState, StateSetter } from './types.js'

export interface SessionCatalogActionHost {
  readonly client: ProtocolClient
  readonly getState: () => AppState
  readonly setState: StateSetter
  readonly refresh: () => Promise<void>
  readonly open: (sessionId: string) => Promise<void>
  readonly loadArchivedSessions: () => Promise<void>
  readonly nextOpenIntent: () => number
  readonly currentOpenIntent: () => number
  readonly isOpenIntentCurrent: (intent: number) => boolean
}

export type SessionCatalogActionMethods = Pick<
  AppActions,
  | 'searchSessions'
  | 'renameSession'
  | 'addWorkspaceFolder'
  | 'renameWorkspace'
  | 'removeWorkspace'
  | 'moveWorkspace'
  | 'moveSession'
  | 'forkSession'
  | 'openSkillDocument'
  | 'removeSession'
  | 'loadArchivedSessions'
  | 'restoreSession'
  | 'deleteSession'
>

export function createSessionCatalogActions(host: SessionCatalogActionHost): SessionCatalogActionMethods {
  const { client, getState, setState, refresh, open, loadArchivedSessions } = host
  return {
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
      const navigationIntent = host.nextOpenIntent()
      const source = getState().sessions.find((session) => session.id === sessionId)
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
        const childTitle = nextForkTitle(source.title, getState().sessions, source.workspaceId)
        try {
          await client.request<unknown>({
            type: 'session.rename',
            requestId: requestId(),
            payload: { sessionId: childId, title: childTitle },
          })
        } catch (reason: unknown) {
          // The fork is already durable. Open it before surfacing a rename
          // failure so a failed cosmetic follow-up never strands the child.
          if (host.isOpenIntentCurrent(navigationIntent)) await open(childId)
          else await refresh()
          throw reason
        }
      }
      if (host.isOpenIntentCurrent(navigationIntent)) await open(childId)
      else await refresh()
    },
    openSkillDocument: async (sessionId, skillId) => {
      await client.request<unknown>({
        type: 'skill.openDocument',
        requestId: requestId(),
        payload: { sessionId, skillId },
      })
    },
    removeSession: async (sessionId) => {
      const wasActive = getState().activeSessionId === sessionId
      const navigationIntent = host.currentOpenIntent()
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
      if (
        wasActive &&
        host.isOpenIntentCurrent(navigationIntent) &&
        getState().activeSessionId === undefined
      ) {
        const replacement = getState().sessions[0]
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
      const wasActive = getState().activeSessionId === sessionId
      const navigationIntent = host.currentOpenIntent()
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
      if (
        wasActive &&
        host.isOpenIntentCurrent(navigationIntent) &&
        getState().activeSessionId === undefined
      ) {
        const replacement = getState().sessions[0]
        if (replacement !== undefined) await open(replacement.id)
      }
    },
  }
}
