import {
  type MessageAttachment,
  type MessageImageReference,
  type TeamActivityView,
  type TokenUsage,
  type UserQuestionReplyView,
  type WorkflowMember,
  type WorkflowSummary,
} from '@dsh-vscode/domain'

import { object } from '../../app/store/unknown-record.js'
import { positiveSafeInteger, questionItems, nonEmptyString } from '../../app/store/event-values.js'

export function finiteTransientSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function finiteTransientStartSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1 ? value : undefined
}

export function finiteEventTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : undefined
  }
  return undefined
}

export function parseTokenUsage(value: unknown): TokenUsage | undefined {
  const record = object(value)
  if (record === undefined) return undefined
  const inputValue = Object.prototype.hasOwnProperty.call(record, 'inputTokens')
    ? record.inputTokens
    : record.uncachedInputTokens
  const inputTokens = tokenCount(inputValue)
  const outputTokens = tokenCount(record.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const totalTokens = tokenCount(record.totalTokens)
  const cacheReadTokens = tokenCount(record.cacheReadTokens)
  const cacheWriteTokens = tokenCount(record.cacheWriteTokens)
  const reasoningTokens = tokenCount(record.reasoningTokens)
  if (
    (Object.prototype.hasOwnProperty.call(record, 'totalTokens') && totalTokens === undefined) ||
    (Object.prototype.hasOwnProperty.call(record, 'cacheReadTokens') && cacheReadTokens === undefined) ||
    (Object.prototype.hasOwnProperty.call(record, 'cacheWriteTokens') && cacheWriteTokens === undefined) ||
    (Object.prototype.hasOwnProperty.call(record, 'reasoningTokens') && reasoningTokens === undefined)
  )
    return undefined
  return {
    inputTokens,
    outputTokens,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

export function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function messageAttachments(value: unknown): readonly MessageAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (value.length > 32) return undefined
  const attachments: MessageAttachment[] = []
  for (const entry of value) {
    const record = object(entry)
    if (
      record === undefined ||
      typeof record.name !== 'string' ||
      record.name.trim() === '' ||
      (Object.prototype.hasOwnProperty.call(record, 'mimeType') && typeof record.mimeType !== 'string')
    )
      return undefined
    attachments.push({
      name: record.name,
      ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
    })
  }
  return attachments
}

export function messageSessionReferenceLabels(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined
  const labels: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '' || entry.length > 512) return undefined
    if (!labels.includes(entry)) labels.push(entry)
  }
  return labels
}

export function messageImages(value: unknown): readonly MessageImageReference[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (value.length > 32) return undefined
  const images: MessageImageReference[] = []
  for (const entry of value) {
    const record = object(entry)
    const attachmentId = typeof record?.attachmentId === 'string' ? record.attachmentId.trim() : ''
    const mediaType = record?.mediaType
    const bytes = positiveSafeInteger(record?.bytes)
    const width = positiveSafeInteger(record?.width)
    const height = positiveSafeInteger(record?.height)
    if (
      attachmentId === '' ||
      (mediaType !== 'image/png' &&
        mediaType !== 'image/jpeg' &&
        mediaType !== 'image/webp' &&
        mediaType !== 'image/gif') ||
      bytes === undefined ||
      width === undefined ||
      height === undefined ||
      (Object.prototype.hasOwnProperty.call(record ?? {}, 'name') &&
        record?.name !== undefined &&
        (typeof record.name !== 'string' || record.name.trim() === ''))
    )
      return undefined
    images.push({
      attachmentId,
      mediaType,
      bytes,
      width,
      height,
      ...(typeof record?.name === 'string' ? { name: record.name } : {}),
    })
  }
  const unique: MessageImageReference[] = []
  const seen = new Set<string>()
  for (const image of images) {
    if (seen.has(image.attachmentId)) continue
    seen.add(image.attachmentId)
    unique.push(image)
  }
  return unique
}

export function nonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function parseTeamActivity(value: unknown): TeamActivityView | undefined {
  const activity = object(value)
  if (activity === undefined || typeof activity.id !== 'string' || typeof activity.teamId !== 'string')
    return undefined
  if (
    activity.kind === 'member' &&
    typeof activity.memberId === 'string' &&
    typeof activity.name === 'string' &&
    (activity.phase === 'provisioning' || activity.phase === 'active' || activity.phase === 'failed')
  )
    return {
      kind: 'member',
      id: activity.id,
      teamId: activity.teamId,
      memberId: activity.memberId,
      name: activity.name,
      phase: activity.phase,
      ...(typeof activity.error === 'string' ? { error: activity.error } : {}),
    }
  if (
    activity.kind === 'task' &&
    typeof activity.taskId === 'string' &&
    typeof activity.subject === 'string' &&
    (activity.status === 'pending' ||
      activity.status === 'in_progress' ||
      activity.status === 'completed' ||
      activity.status === 'deleted') &&
    typeof activity.blockedByCount === 'number' &&
    Number.isSafeInteger(activity.blockedByCount) &&
    activity.blockedByCount >= 0 &&
    typeof activity.writeScopeCount === 'number' &&
    Number.isSafeInteger(activity.writeScopeCount) &&
    activity.writeScopeCount >= 0
  )
    return {
      kind: 'task',
      id: activity.id,
      teamId: activity.teamId,
      taskId: activity.taskId,
      subject: activity.subject,
      status: activity.status,
      ...(typeof activity.ownerId === 'string' ? { ownerId: activity.ownerId } : {}),
      blockedByCount: activity.blockedByCount,
      writeScopeCount: activity.writeScopeCount,
    }
  if (
    (activity.kind === 'message.queued' || activity.kind === 'message.delivered') &&
    typeof activity.messageId === 'string' &&
    typeof activity.targetId === 'string'
  )
    return {
      kind: activity.kind,
      id: activity.id,
      teamId: activity.teamId,
      messageId: activity.messageId,
      ...(typeof activity.senderName === 'string' ? { senderName: activity.senderName } : {}),
      targetId: activity.targetId,
      ...(activity.delivery === 'quiet' || activity.delivery === 'wakeup'
        ? { delivery: activity.delivery }
        : {}),
      ...(typeof activity.content === 'string' ? { content: activity.content } : {}),
    }
  return undefined
}

export function isToolStatus(
  value: unknown,
): value is 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' {
  return (
    value === 'queued' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  )
}

export function parseUserQuestionReply(value: unknown): UserQuestionReplyView | undefined {
  const reply = object(value)
  const questions = reply?.questions === undefined ? undefined : questionItems(reply.questions)
  if (
    reply === undefined ||
    !nonEmptyString(reply.callId) ||
    questions === undefined ||
    !Array.isArray(reply.answers) ||
    reply.answers.length !== questions.length
  )
    return undefined
  const answers: UserQuestionReplyView['answers'][number][] = []
  for (const entry of reply.answers) {
    const answer = object(entry)
    if (
      answer === undefined ||
      !nonEmptyString(answer.id) ||
      !Array.isArray(answer.selected) ||
      !answer.selected.every((selected) => typeof selected === 'string') ||
      (answer.custom !== undefined && typeof answer.custom !== 'string')
    )
      return undefined
    answers.push({
      id: answer.id,
      selected: answer.selected,
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    })
  }
  const questionIds = new Set(questions.map((question) => question.id))
  const answerIds = new Set(answers.map((answer) => answer.id))
  if (questionIds.size !== questions.length || answerIds.size !== answers.length) return undefined
  if ([...questionIds].some((id) => !answerIds.has(id))) return undefined
  return { callId: reply.callId, questions, answers }
}

export function isWorkflowMember(value: unknown): value is WorkflowMember {
  const item = object(value)
  return (
    item !== undefined &&
    Number.isSafeInteger(item.seq) &&
    (item.seq as number) > 0 &&
    typeof item.label === 'string' &&
    typeof item.childId === 'string' &&
    typeof item.status === 'string' &&
    MEMBER_STATUSES.includes(item.status)
  )
}

export function isWorkflowStage(value: unknown): value is WorkflowSummary['stages'][number] {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    (typeof item.phase === 'string' || item.phase === null) &&
    Array.isArray(item.members) &&
    item.members.every(isWorkflowMember)
  )
}

export function isWorkflowSummary(value: unknown): value is WorkflowSummary {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    typeof item.sessionId === 'string' &&
    typeof item.name === 'string' &&
    typeof item.status === 'string' &&
    WORKFLOW_STATUSES.includes(item.status) &&
    Array.isArray(item.stages) &&
    item.stages.every(isWorkflowStage)
  )
}

const WORKFLOW_STATUSES: readonly string[] = ['running', 'completed', 'failed', 'cancelled', 'interrupted']

const MEMBER_STATUSES: readonly string[] = ['running', 'completed', 'failed', 'cancelled', 'interrupted']
