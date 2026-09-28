import type { SessionSummary, WorkspaceSummary } from '@dsh-vscode/domain'

import type { Translate } from '../../i18n.js'
import { displaySessionTitle } from './session-title.js'

export type SessionSorting = 'manual' | 'updated'
export type WorkspaceDisplay = 'current' | 'grouped'
export type ArchiveFilter = 'hide' | 'all' | 'archived'
export const ARCHIVE_FILTERS: readonly ArchiveFilter[] = ['hide', 'all', 'archived']
export const DEFAULT_WORKSPACE_NAME = 'default-workspace'

export type RenameTarget =
  | { readonly kind: 'session'; readonly id: string; readonly title: string; readonly workspaceId: string }
  | { readonly kind: 'workspace'; readonly id: string; readonly title: string }

/** `session.search` wire bound, measured in JavaScript UTF-16 code units. */
export const SEARCH_QUERY_MAX_CODE_UNITS = 500
export const ORDER_DRAG_MIME = 'application/x-dsh-order'

export type OrderDrag =
  | { readonly kind: 'workspace'; readonly itemId: string }
  | { readonly kind: 'session'; readonly workspaceId: string; readonly itemId: string }

/**
 * Keep the controlled input and the request inside the `session.search` wire
 * contract: the host refuses a query carrying a NUL or one over the code-unit
 * bound, and a query the field never let through cannot be sent in error.
 */
export function sanitizeSearchQuery(value: string): string {
  const withoutNul = value.replaceAll('\u0000', '')
  if (withoutNul.length <= SEARCH_QUERY_MAX_CODE_UNITS) return withoutNul
  let end = SEARCH_QUERY_MAX_CODE_UNITS
  const last = withoutNul.charCodeAt(end - 1)
  const next = withoutNul.charCodeAt(end)
  // Never cut a surrogate pair in half: half a pair is not a character.
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1
  return withoutNul.slice(0, end)
}

export function readOrderDrag(dataTransfer: DataTransfer): OrderDrag | undefined {
  try {
    const value: unknown = JSON.parse(dataTransfer.getData(ORDER_DRAG_MIME))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (record.kind === 'workspace' && typeof record.itemId === 'string' && record.itemId !== '')
      return { kind: 'workspace', itemId: record.itemId }
    if (
      record.kind === 'session' &&
      typeof record.workspaceId === 'string' &&
      record.workspaceId !== '' &&
      typeof record.itemId === 'string' &&
      record.itemId !== ''
    )
      return { kind: 'session', workspaceId: record.workspaceId, itemId: record.itemId }
  } catch {
    return undefined
  }
  return undefined
}

export function sortSessions(
  sessions: readonly SessionSummary[],
  sorting: SessionSorting,
  manualOrder?: readonly string[],
  activeSessionId?: string,
): readonly SessionSummary[] {
  if (sorting === 'manual') {
    const position = new Map((manualOrder ?? []).map((id, index) => [id, index]))
    const sorted = [...sessions].sort(
      (left, right) =>
        (position.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (position.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    )
    return pinCurrentBlank(sorted, activeSessionId)
  }
  return [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

/**
 * The official workspace runtime promotes the current blank New Session row
 * to the head of the workspace order. Keep that visual invariant even when a
 * stale session-order projection still places another row first.
 */
export function pinCurrentBlank(
  sessions: readonly SessionSummary[],
  activeSessionId: string | undefined,
): readonly SessionSummary[] {
  if (activeSessionId === undefined) return sessions
  const index = sessions.findIndex((session) => session.id === activeSessionId && session.blank)
  if (index <= 0) return sessions
  const active = sessions[index]
  if (active === undefined) return sessions
  return [active, ...sessions.slice(0, index), ...sessions.slice(index + 1)]
}

export function sessionStatusIcon(status: SessionSummary['status']): 'alert' | 'check' | 'clock' | 'play' {
  switch (status) {
    case 'running':
      return 'play'
    case 'completed':
      return 'check'
    case 'failed':
    case 'awaiting-input':
      return 'alert'
    case 'idle':
      return 'clock'
  }
}

export function sessionStatusTone(
  status: SessionSummary['status'],
): 'blue' | 'green' | 'amber' | 'red' | 'muted' {
  switch (status) {
    case 'running':
      return 'blue'
    case 'awaiting-input':
      return 'amber'
    case 'completed':
      return 'green'
    case 'failed':
      return 'red'
    case 'idle':
      return 'muted'
  }
}

export function workspaceDisplayName(name: string, t: Translate): string {
  return name === DEFAULT_WORKSPACE_NAME ? t('sessions.defaultWorkspace') : name
}

export interface SessionListProjectionInput {
  readonly sessions: readonly SessionSummary[]
  readonly archivedSessions: readonly SessionSummary[]
  readonly visibleWorkspaces: readonly WorkspaceSummary[]
  readonly activeSessionId: string | undefined
  readonly selectedWorkspace: WorkspaceSummary | undefined
  readonly contentMatches: readonly SessionSummary[]
  readonly query: string
  readonly sorting: SessionSorting
  readonly archiveFilter: ArchiveFilter
  readonly workspaceDisplay: WorkspaceDisplay
  readonly t: Translate
}

export interface WorkspaceSessionGroup {
  readonly workspace: WorkspaceSummary
  readonly sessions: readonly SessionSummary[]
}

export interface SessionListProjection {
  readonly current: readonly SessionSummary[]
  readonly grouped: readonly WorkspaceSessionGroup[]
  /** Content-search hits the visible lists do not already show. */
  readonly contentMatches: readonly SessionSummary[]
  /** Archived rows in the selected workspace scope, before the text filter. */
  readonly archivedInScope: readonly SessionSummary[]
  readonly archived: readonly SessionSummary[]
}

export function workspaceSessionsFor(
  input: SessionListProjectionInput,
  workspace: WorkspaceSummary,
): readonly SessionSummary[] {
  return input.sessions.filter(
    (session) =>
      session.origin !== 'subagent' &&
      (session.workspaceId === workspace.id || workspace.sessionIds?.includes(session.id) === true) &&
      (!session.blank || session.id === input.activeSessionId),
  )
}

export function filterWorkspaceSessions(
  input: SessionListProjectionInput,
  workspace: WorkspaceSummary,
): readonly SessionSummary[] {
  const sessions = workspaceSessionsFor(input, workspace)
  const filtered =
    input.query === ''
      ? sessions
      : sessions.filter((session) =>
          displaySessionTitle(session.title, input.t).toLowerCase().includes(input.query),
        )
  return sortSessions(filtered, input.sorting, workspace.sessionIds, input.activeSessionId)
}

export function projectSessionLists(input: SessionListProjectionInput): SessionListProjection {
  const current =
    input.archiveFilter !== 'archived' &&
    input.workspaceDisplay === 'current' &&
    input.selectedWorkspace !== undefined
      ? filterWorkspaceSessions(input, input.selectedWorkspace)
      : []
  const grouped =
    input.archiveFilter !== 'archived' && input.workspaceDisplay === 'grouped'
      ? input.visibleWorkspaces.map((workspace) => ({
          workspace,
          sessions: filterWorkspaceSessions(input, workspace),
        }))
      : []
  const locallyVisibleIds = new Set(current.map((session) => session.id))
  const groupedVisibleIds = new Set(grouped.flatMap(({ sessions }) => sessions.map(({ id }) => id)))
  const contentMatches =
    input.archiveFilter !== 'archived' && input.workspaceDisplay === 'grouped'
      ? sortSessions(
          input.contentMatches.filter(
            (session) =>
              !groupedVisibleIds.has(session.id) && session.origin !== 'subagent' && !session.blank,
          ),
          input.sorting,
        )
      : input.archiveFilter !== 'archived' && input.workspaceDisplay === 'current'
        ? sortSessions(
            input.contentMatches.filter(
              (session) =>
                !locallyVisibleIds.has(session.id) && session.origin !== 'subagent' && !session.blank,
            ),
            input.sorting,
          )
        : []
  const archivedToShow =
    input.archiveFilter === 'archived' &&
    input.workspaceDisplay === 'current' &&
    input.selectedWorkspace !== undefined
      ? input.archivedSessions.filter(
          (session) =>
            session.workspaceId === input.selectedWorkspace?.id ||
            input.selectedWorkspace?.sessionIds?.includes(session.id) === true,
        )
      : input.archivedSessions
  const archived = archivedToShow.filter(
    (session) =>
      input.query === '' || displaySessionTitle(session.title, input.t).toLowerCase().includes(input.query),
  )
  return { current, grouped, contentMatches, archivedInScope: archivedToShow, archived }
}

export interface RenameConflictInput {
  readonly target: RenameTarget | undefined
  readonly draft: string
  readonly sessions: readonly SessionSummary[]
  readonly workspaces: readonly WorkspaceSummary[]
  readonly t: Translate
}

export function renameConflictFor(input: RenameConflictInput): boolean {
  const { target, draft, sessions, workspaces } = input
  const title = draft.trim()
  if (target === undefined) return false
  if (target.kind === 'session')
    return sessions.some(
      (session) =>
        session.id !== target.id &&
        // A row from the "content matches" list belongs to another workspace;
        // the warning names "this workspace", so it has to compare inside the
        // renamed session's own workspace.
        session.workspaceId === target.workspaceId &&
        session.title.trim().toLocaleLowerCase() === title.toLocaleLowerCase() &&
        title !== '',
    )
  if (title === workspaceDisplayName(target.title.trim(), input.t)) return false
  return workspaces.some(
    (workspace) =>
      workspace.id !== target.id &&
      workspace.name.trim().toLocaleLowerCase() === title.toLocaleLowerCase() &&
      title !== '',
  )
}
