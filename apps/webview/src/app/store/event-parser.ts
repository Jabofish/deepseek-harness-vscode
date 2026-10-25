import type { HostMessage } from '@dsh-vscode/webview-protocol'
import type { BackendEvent } from '@dsh-vscode/domain'
import { object } from './unknown-record.js'
import { finiteEventSequence } from './event-values.js'
import { parseSessionEvents } from './session-events.js'
import { parseControlEvents } from './control-events.js'
import { parseInteractionEvents } from './interaction-events.js'
import { parseWorkspaceEvents } from './workspace-events.js'

/** Only control facts cross this boundary. Bodies arrive as validated Host windows. */
export function parseHostDomainEvent(message: HostMessage): BackendEvent | null | undefined {
  if (message.type !== 'event' || !CONTROL_EVENTS.has(message.name)) return undefined
  const value = object(message.payload)
  if (value === undefined) return null
  const sequence = finiteEventSequence(value.sequence)
  if (value.sequence !== undefined && sequence === undefined) return null
  const control = parseControlEvents(message.name, value, message.payload)
  if (control === null) return null
  const event =
    control ??
    parseSessionEvents(message.name, value, message.payload) ??
    parseInteractionEvents(message.name, value, message.payload) ??
    parseWorkspaceEvents(message.name, value, message.payload)
  return event === undefined ? null : sequence === undefined ? event : { ...event, sequence }
}

const CONTROL_EVENTS = new Set([
  'session.system',
  'session.status',
  'session.activity',
  'session.subscribed',
  'session.title',
  'session.configuration',
  'session.added',
  'session.removed',
  'session.projection',
  'session.projection.baseline',
  'subagent.catalog.updated',
  'workspace.changed',
  'workspace.order.changed',
  'workspace.removed',
  'archived.sessions.changed',
  'queue.updated',
  'goal.updated',
  'jobs.updated',
  'job.follow.updated',
  'job.follow.failed',
  'permission.requested',
  'permission.resolved',
  'question.requested',
  'question.resolved',
  'question.reply.status',
  'turn.started',
  'turn.ended',
  'connection.lost',
  'remote.event',
])

/** Host UI messages never enter the conversation event pipeline. */
export function isSurfaceEventName(name: string): boolean {
  return [
    'ui.surface.assigned',
    'ui.surface.handoff',
    'ui.surface.openInEditor',
    'ui.surface.openInSidebar',
  ].includes(name)
}
