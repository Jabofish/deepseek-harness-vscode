import { nonEmptyString } from './event-values.js'

import type { BackendEvent } from '@dsh-vscode/domain'

/** Branches are matched by event name; the caller owns the name-mutual-exclusion ordering. */
export function parseWorkspaceEvents(
  name: string,
  value: Record<string, unknown>,
  payload: unknown,
): BackendEvent | undefined {
  if (name === 'workspace.changed') {
    const hasWorkspaceId = Object.hasOwn(value, 'workspaceId')
    const workspaceId = hasWorkspaceId && nonEmptyString(value.workspaceId) ? value.workspaceId : undefined
    if (hasWorkspaceId && workspaceId === undefined) return { type: 'unknown', name, payload }
    return {
      type: 'workspace.changed',
      ...(workspaceId === undefined ? {} : { workspaceId }),
    }
  }
  if (name === 'workspace.removed') {
    const hasWorkspaceId = Object.hasOwn(value, 'workspaceId')
    const workspaceId = hasWorkspaceId && nonEmptyString(value.workspaceId) ? value.workspaceId : undefined
    if (hasWorkspaceId && workspaceId === undefined) return { type: 'unknown', name, payload }
    return {
      type: 'workspace.removed',
      ...(workspaceId === undefined ? {} : { workspaceId }),
    }
  }
  if (
    name === 'workspace.order.changed' &&
    Array.isArray(value.workspaceIds) &&
    value.workspaceIds.every((entry) => nonEmptyString(entry))
  )
    return {
      type: 'workspace.order.changed',
      workspaceIds: value.workspaceIds,
    }
  if (
    name === 'archived.sessions.changed' &&
    Array.isArray(value.sessionIds) &&
    value.sessionIds.every((entry) => nonEmptyString(entry))
  )
    return {
      type: 'archived.sessions.changed',
      sessionIds: value.sessionIds,
    }
  return undefined
}
