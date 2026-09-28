import { object, isRecord } from './unknown-record.js'
import { parseSubagentCatalogEntryFact } from './tool-presentation.js'
import { configurationPatch, nonEmptyString, parseSessionProjection } from './event-values.js'

import type { BackendEvent, SessionProjectionSnapshot } from '@dsh-vscode/domain'

/** Branches are matched by event name; the caller owns the name-mutual-exclusion ordering. */
export function parseSessionEvents(
  name: string,
  value: Record<string, unknown>,
  payload: unknown,
): BackendEvent | undefined {
  if (name === 'session.system' && nonEmptyString(value.sessionId))
    return { type: 'session.system', sessionId: value.sessionId }
  if (name === 'subagent.catalog.updated' && nonEmptyString(value.sessionId)) {
    const entry = parseSubagentCatalogEntryFact(value.entry)
    if (entry !== undefined) return { type: 'subagent.catalog.updated', sessionId: value.sessionId, entry }
  }
  if (name === 'session.status' && nonEmptyString(value.sessionId) && typeof value.status === 'string')
    return { type: 'session.status', sessionId: value.sessionId, status: value.status }
  if (
    name === 'session.activity' &&
    nonEmptyString(value.sessionId) &&
    typeof value.updatedAt === 'number' &&
    Number.isSafeInteger(value.updatedAt) &&
    value.updatedAt >= 0
  )
    return { type: 'session.activity', sessionId: value.sessionId, updatedAt: value.updatedAt }
  if (
    name === 'session.subscribed' &&
    nonEmptyString(value.sessionId) &&
    typeof value.lastSequence === 'number' &&
    Number.isSafeInteger(value.lastSequence) &&
    value.lastSequence >= -1
  ) {
    const hasProjection = Object.hasOwn(value, 'projection')
    let projection: SessionProjectionSnapshot | undefined
    if (hasProjection) {
      try {
        projection = parseSessionProjection(value.projection)
      } catch {
        return { type: 'unknown', name, payload }
      }
    }
    if (hasProjection && projection === undefined) return { type: 'unknown', name, payload }
    if (value.controlBaseline !== undefined && typeof value.controlBaseline !== 'boolean')
      return { type: 'unknown', name, payload }
    return {
      type: 'session.subscribed',
      sessionId: value.sessionId,
      lastSequence: value.lastSequence,
      ...(value.controlBaseline === undefined ? {} : { controlBaseline: value.controlBaseline }),
      ...(projection === undefined ? {} : { projection }),
    }
  }
  if (name === 'session.title' && nonEmptyString(value.sessionId) && typeof value.title === 'string')
    return { type: 'session.title', sessionId: value.sessionId, title: value.title }
  if (name === 'session.configuration' && nonEmptyString(value.sessionId) && isRecord(value.patch)) {
    const patch = configurationPatch(value.patch)
    if (patch !== undefined) return { type: 'session.configuration', sessionId: value.sessionId, patch }
  }
  if (name === 'session.added' && nonEmptyString(value.sessionId)) {
    const hasParentSessionId = Object.hasOwn(value, 'parentSessionId')
    const hasOrigin = Object.hasOwn(value, 'origin')
    const hasCwd = Object.hasOwn(value, 'cwd')
    const hasAgentPreset = Object.hasOwn(value, 'agentPreset')
    if (
      typeof value.blank !== 'boolean' ||
      (Object.hasOwn(value, 'agentAvailable') && typeof value.agentAvailable !== 'boolean') ||
      (hasParentSessionId &&
        (typeof value.parentSessionId !== 'string' || value.parentSessionId.trim() === '')) ||
      (hasOrigin && value.origin !== 'subagent') ||
      (hasCwd && typeof value.cwd !== 'string') ||
      (hasAgentPreset && typeof value.agentPreset !== 'string')
    )
      return { type: 'unknown', name, payload }
    return {
      type: 'session.added',
      sessionId: value.sessionId,
      blank: value.blank,
      ...(typeof value.agentAvailable === 'boolean' ? { agentAvailable: value.agentAvailable } : {}),
      ...(typeof value.parentSessionId === 'string' ? { parentSessionId: value.parentSessionId } : {}),
      ...(value.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
      ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
      ...(typeof value.agentPreset === 'string' ? { agentPreset: value.agentPreset } : {}),
    }
  }
  if (name === 'session.removed' && nonEmptyString(value.sessionId))
    return { type: 'session.removed', sessionId: value.sessionId }
  if (name === 'session.projection.baseline') {
    const rawProjections = object(value.projections)
    if (rawProjections === undefined) return { type: 'unknown', name, payload }
    const projections: Record<string, SessionProjectionSnapshot> = Object.create(null) as Record<
      string,
      SessionProjectionSnapshot
    >
    for (const [sessionId, rawProjection] of Object.entries(rawProjections)) {
      if (!nonEmptyString(sessionId)) return { type: 'unknown', name, payload }
      try {
        const projection = parseSessionProjection(rawProjection)
        if (projection === undefined) return { type: 'unknown', name, payload }
        projections[sessionId] = projection
      } catch {
        return { type: 'unknown', name, payload }
      }
    }
    return { type: 'session.projection.baseline', projections }
  }
  if (
    name === 'session.projection' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.key) &&
    Object.hasOwn(value, 'value')
  )
    return { type: 'session.projection', sessionId: value.sessionId, key: value.key, value: value.value }
  if (
    name === 'session.gap' &&
    nonEmptyString(value.sessionId) &&
    typeof value.fromSequence === 'number' &&
    Number.isSafeInteger(value.fromSequence) &&
    value.fromSequence >= 0 &&
    typeof value.toSequence === 'number' &&
    Number.isSafeInteger(value.toSequence) &&
    value.toSequence >= value.fromSequence
  )
    return {
      type: 'session.gap',
      sessionId: value.sessionId,
      fromSequence: value.fromSequence,
      toSequence: value.toSequence,
    }
  return undefined
}
