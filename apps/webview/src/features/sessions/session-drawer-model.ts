import type { SessionSummary } from '@dsh-vscode/domain'

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
