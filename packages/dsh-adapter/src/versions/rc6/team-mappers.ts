import type {
  BackendEvent,
  SessionConfigurationPatch,
  TeamActivityView,
} from '@dsh-vscode/domain'

import { contentText } from './message-mappers.js'
import { bounded, firstString, stringOr } from './value-guards.js'
import { recordOrUndefined as objectOrUndefined } from '../../repositories/shared/guards.js'

export function sessionConfiguration(sessionId: string, patch: SessionConfigurationPatch): BackendEvent {
  return { type: 'session.configuration', sessionId, patch }
}

export function planMode(data: Record<string, unknown>): boolean {
  if (typeof data.active === 'boolean') return data.active
  if (typeof data.enabled === 'boolean') return data.enabled
  if (typeof data.on === 'boolean') return data.on
  const mode = stringOr(data.mode ?? data.value, '').toLowerCase()
  return mode === 'plan' || mode === 'on' || mode === 'active'
}

export function workspaceId(data: Record<string, unknown>): string | undefined {
  const workspace = objectOrUndefined(data.workspace)
  return firstString(data.workspaceId, data.id, workspace?.workspaceId, workspace?.id)
}

export function workflowMemberOutcome(value: unknown): 'completed' | 'failed' | 'cancelled' {
  if (value === 'completed' || value === 'failed' || value === 'cancelled') return value
  throw new Error('Malformed workflow member outcome')
}

export function workflowStopReason(value: unknown): 'completed' | 'cancelled' | 'error' {
  if (value === 'completed' || value === 'cancelled' || value === 'error') return value
  throw new Error('Malformed workflow stop reason')
}

/**
 * Project the experimental Team events into a bounded read-only activity row.
 *
 * The payload version selects the contract, not the surface: v1 carries a
 * `delivery` mode on every queued message, while newer releases unified peer
 * messages onto steer, dropped that field, and bumped the envelope to v2. Both
 * shapes project to the same row, so keying the row on a single version would
 * silently turn every Team event on the other host line into an unknown one.
 */
export function teamActivity(name: string, data: Record<string, unknown>): TeamActivityView | undefined {
  const version = data.version
  if ((version !== 1 && version !== 2) || typeof data.teamId !== 'string' || data.teamId.trim() === '')
    return undefined
  if (name === 'team/member') {
    const member = objectOrUndefined(data.member)
    if (
      member === undefined ||
      typeof member.id !== 'string' ||
      typeof member.name !== 'string' ||
      (member.phase !== 'provisioning' && member.phase !== 'active' && member.phase !== 'failed')
    )
      return undefined
    return {
      kind: 'member',
      id: `team:member:${data.teamId}:${member.id}`,
      teamId: data.teamId,
      memberId: member.id,
      name: bounded(member.name),
      phase: member.phase,
      // The roster stores `errorMessage(error)` verbatim, so a failed
      // provisioning can explain itself at any length the surfaced error has.
      // The card renders this as the failure reason, and the wire budget owns
      // the only real ceiling.
      ...(typeof member.error === 'string' ? { error: member.error } : {}),
    }
  }
  if (name === 'team/task') {
    const task = objectOrUndefined(data.task)
    const blockedBy = task === undefined ? undefined : task.blockedBy
    const writeScopes = task === undefined ? undefined : task.writeScopes
    if (
      task === undefined ||
      typeof task.id !== 'string' ||
      typeof task.subject !== 'string' ||
      !teamTaskStatus(task.status) ||
      !stringArrayValue(blockedBy) ||
      !stringArrayValue(writeScopes)
    )
      return undefined
    return {
      kind: 'task',
      id: `team:task:${data.teamId}:${task.id}`,
      teamId: data.teamId,
      taskId: task.id,
      subject: bounded(task.subject),
      status: task.status,
      ...(typeof task.ownerId === 'string' ? { ownerId: task.ownerId } : {}),
      blockedByCount: blockedBy.length,
      writeScopeCount: writeScopes.length,
    }
  }
  if (name === 'team/message/queued') {
    const message = objectOrUndefined(data.message)
    const content = message === undefined ? undefined : message.content
    // The v1 contract types the mode as required, so a v1 payload without one
    // is malformed; v2 has no such field to read.
    const delivery =
      message?.delivery === 'quiet' || message?.delivery === 'wakeup' ? message.delivery : undefined
    if (
      message === undefined ||
      typeof message.id !== 'string' ||
      typeof message.senderName !== 'string' ||
      typeof message.targetId !== 'string' ||
      (version === 1 && delivery === undefined) ||
      !Array.isArray(content)
    )
      return undefined
    return {
      kind: 'message.queued',
      id: `team:message:queued:${data.teamId}:${message.id}`,
      teamId: data.teamId,
      messageId: message.id,
      senderName: bounded(message.senderName),
      targetId: message.targetId,
      ...(delivery === undefined ? {} : { delivery }),
      // The mailbox admits any body whose framed delivery fits
      // `maxMessageBytes` (65,536 by default), so a peer message is routinely
      // longer than a card-sized preview; the card shows what the sender wrote.
      content: contentText(content, false),
    }
  }
  if (name === 'team/message/delivered') {
    if (typeof data.messageId !== 'string' || typeof data.targetId !== 'string') return undefined
    return {
      kind: 'message.delivered',
      id: `team:message:delivered:${data.teamId}:${data.messageId}`,
      teamId: data.teamId,
      messageId: data.messageId,
      targetId: data.targetId,
    }
  }
  return undefined
}

function teamTaskStatus(value: unknown): value is 'pending' | 'in_progress' | 'completed' | 'deleted' {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'deleted'
}

function stringArrayValue(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}
