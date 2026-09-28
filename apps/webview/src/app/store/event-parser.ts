import { type HostMessage } from '@dsh-vscode/webview-protocol'
import { type BackendEvent } from '@dsh-vscode/domain'
import { object } from './unknown-record.js'
import { finiteEventSequence } from './event-values.js'
import { parseMessageEvents } from './message-events.js'
import { parseSessionEvents } from './session-events.js'
import { parseToolEvents } from './tool-events.js'
import { parseWorkflowTeamEvents } from './workflow-team-events.js'
import { parseInteractionEvents } from './interaction-events.js'
import { parseWorkspaceEvents } from './workspace-events.js'
import { parseNoticeEvents } from './notice-events.js'

export { timelineSequenceOptions } from './sequence-rules.js'

export function domainEvent(name: string, payload: unknown): BackendEvent | undefined {
  const raw = object(payload)
  if (raw !== undefined && raw.sequence !== undefined && finiteEventSequence(raw.sequence) === undefined)
    return {
      type: 'unknown',
      ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
      name,
      payload,
    }
  const event = parseDomainEvent(name, payload)
  if (event === undefined) return undefined
  const sequence = finiteEventSequence(object(payload)?.sequence)
  return sequence === undefined ? event : { ...event, sequence }
}

function parseDomainEvent(name: string, payload: unknown): BackendEvent | undefined {
  const value = object(payload)
  if (value === undefined) return { type: 'unknown', name, payload }
  const workflowEvent = parseWorkflowTeamEvents(name, value, payload)
  if (workflowEvent === null) return undefined
  return (
    parseMessageEvents(name, value, payload) ??
    parseSessionEvents(name, value, payload) ??
    parseToolEvents(name, value, payload) ??
    workflowEvent ??
    parseInteractionEvents(name, value, payload) ??
    parseWorkspaceEvents(name, value, payload) ??
    parseNoticeEvents(name, value, payload) ?? {
      type: 'unknown',
      ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
      name,
      payload,
    }
  )
}

export function parseHostDomainEvent(message: HostMessage): BackendEvent | null | undefined {
  if (message.type !== 'event') return undefined
  if (
    message.name === 'runtime.update.progress' ||
    message.name === 'ui.sessions.toggle' ||
    message.name === 'ui.settings.toggle' ||
    message.name === 'connection.snapshot'
  )
    return undefined
  return domainEvent(message.name, message.payload) ?? null
}
