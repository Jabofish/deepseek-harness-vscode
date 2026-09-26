import {
  type AgentConfiguration,
  type GoalView,
  type JobView,
  type MessageAttachment,
  type MessageImageReference,
  type PermissionRequest,
  type PermissionOption,
  type PromptAttachment,
  type QuestionChoice,
  type QuestionIntent,
  type QueuedInput,
  type SessionConfigurationPatch,
  type SessionProjectionSnapshot,
  type TeamActivityView,
  type TurnEndFailure,
  type TokenUsage,
  type TodoView,
  type TurnEndReasonKind,
  type UserQuestion,
  type UserQuestionItem,
  type WorkflowMember,
  type WorkflowSummary,
} from '@dsh-vscode/domain'
import { translate } from '../../i18n.js'
import { object, isRecord } from './unknown-record.js'

export function configurationPatch(value: Record<string, unknown>): SessionConfigurationPatch | undefined {
  const modelValue = value.model
  if (
    (value.preset !== undefined && typeof value.preset !== 'string') ||
    (value.toolMode !== undefined && !isToolMode(value.toolMode)) ||
    (value.permissionPreset !== undefined && typeof value.permissionPreset !== 'string') ||
    (value.planMode !== undefined && typeof value.planMode !== 'boolean') ||
    (value.sandboxMode !== undefined && typeof value.sandboxMode !== 'string') ||
    (value.approvalPolicy !== undefined && typeof value.approvalPolicy !== 'string') ||
    (modelValue !== undefined && !isRecord(modelValue))
  )
    return undefined
  if (
    isRecord(modelValue) &&
    ((modelValue.providerId !== undefined && typeof modelValue.providerId !== 'string') ||
      (modelValue.modelId !== undefined && typeof modelValue.modelId !== 'string') ||
      (modelValue.reasoningLevel !== undefined && typeof modelValue.reasoningLevel !== 'string'))
  )
    return undefined
  const model = isRecord(modelValue)
    ? {
        ...(typeof modelValue.providerId === 'string' ? { providerId: modelValue.providerId } : {}),
        ...(typeof modelValue.modelId === 'string' ? { modelId: modelValue.modelId } : {}),
        ...(typeof modelValue.reasoningLevel === 'string'
          ? { reasoningLevel: modelValue.reasoningLevel }
          : {}),
      }
    : undefined
  return {
    ...(typeof value.preset === 'string' ? { preset: value.preset } : {}),
    ...(isToolMode(value.toolMode) ? { toolMode: value.toolMode } : {}),
    ...(typeof value.permissionPreset === 'string'
      ? { permissionPreset: value.permissionPreset, permissionPresetKnown: true }
      : {}),
    ...(typeof value.planMode === 'boolean' ? { planMode: value.planMode, planModeKnown: true } : {}),
    ...(typeof value.sandboxMode === 'string' ? { sandboxMode: value.sandboxMode } : {}),
    ...(typeof value.approvalPolicy === 'string' ? { approvalPolicy: value.approvalPolicy } : {}),
    ...(model === undefined ? {} : { model }),
  }
}

export function projectionAsOfSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1 ? value : undefined
}

export function parseSessionProjection(value: unknown): SessionProjectionSnapshot | undefined {
  if (value === undefined) return undefined
  const projection = object(value)
  if (
    projection === undefined ||
    !Number.isSafeInteger(projection.asOfSequence) ||
    (projection.asOfSequence as number) < -1 ||
    object(projection.values) === undefined
  )
    throw new Error(translate('app.error.malformedProjection'))
  return {
    asOfSequence: projection.asOfSequence as number,
    values: projection.values as Readonly<Record<string, unknown>>,
  }
}

export function finiteTransientSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function finiteTransientStartSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1 ? value : undefined
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export function finiteEventSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function finiteEventIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function finiteEventTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : undefined
  }
  return undefined
}

export function turnEndReason(value: unknown): TurnEndReasonKind {
  const kind = isRecord(value) ? value.kind : value
  return kind === 'completed' ||
    kind === 'aborted' ||
    kind === 'blocked' ||
    kind === 'error' ||
    kind === 'max-tokens' ||
    kind === 'interrupted'
    ? kind
    : 'unknown'
}

export function turnEndFailure(value: unknown): TurnEndFailure | undefined {
  const record = object(value)
  const failure = record?.kind === 'error' ? object(record.error) : record
  if (failure === undefined) return undefined
  if (typeof failure.message !== 'string') return undefined
  const compact = failure.message.replace(/\s+/gu, ' ').trim()
  if (compact === '') return undefined
  const redacted = compact.replace(
    /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret|private[_ -]?key|token|prompt|body|response)\b\s*[:=]\s*[^\s,;]+/giu,
    (match) => match.replace(/[:=].*$/u, ': [redacted]'),
  )
  const code =
    typeof failure.code === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(failure.code)
      ? failure.code
      : undefined
  // The durable reason carries the provider adapter's own failure message, and
  // the reference client renders it whole in its turn-error row. Clipping here
  // would cut the user's only diagnosis with nothing on screen to reveal it.
  return { message: redacted, ...(code === undefined ? {} : { code }) }
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

export function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
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

export function isGoalStatus(value: unknown): value is 'pending' | 'in-progress' | 'completed' | 'blocked' {
  return value === 'pending' || value === 'in-progress' || value === 'completed' || value === 'blocked'
}

export function isJobStatus(
  value: unknown,
): value is 'running' | 'stopping' | 'completed' | 'failed' | 'killed' {
  return (
    value === 'running' ||
    value === 'stopping' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'killed'
  )
}

export function isPermissionKind(value: unknown): value is 'allow-once' | 'deny' {
  return value === 'allow-once' || value === 'deny'
}

export function parsePermissionRequest(value: Record<string, unknown>): PermissionRequest | undefined {
  const options = parsePermissionOptions(value.options)
  const displayReason =
    value.displayReason === undefined ? undefined : parseDisplayReason(value.displayReason)
  if (
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.sessionId) ||
    typeof value.title !== 'string' ||
    typeof value.description !== 'string' ||
    !isPermissionRisk(value.risk) ||
    options === undefined ||
    (value.displayReason !== undefined && displayReason === undefined) ||
    (value.rpcId !== undefined && typeof value.rpcId !== 'string') ||
    (value.callId !== undefined && !nonEmptyString(value.callId)) ||
    (value.commandLine !== undefined && typeof value.commandLine !== 'string')
  )
    return undefined
  return {
    id: value.id,
    ...(value.rpcId === undefined ? {} : { rpcId: value.rpcId }),
    sessionId: value.sessionId,
    title: value.title,
    description: value.description,
    ...(displayReason === undefined ? {} : { displayReason }),
    ...(value.callId === undefined ? {} : { callId: value.callId }),
    ...(value.commandLine === undefined ? {} : { commandLine: value.commandLine }),
    risk: value.risk,
    options,
  }
}

export function parseDisplayReason(value: unknown): PermissionRequest['displayReason'] | undefined {
  const localized = object(value)
  if (
    localized === undefined ||
    !Object.hasOwn(localized, 'en') ||
    typeof localized.en !== 'string' ||
    !Object.values(localized).every((entry) => typeof entry === 'string')
  )
    return undefined
  return { ...localized } as NonNullable<PermissionRequest['displayReason']>
}

export function parsePermissionOptions(value: unknown): readonly PermissionOption[] | undefined {
  if (!Array.isArray(value)) return undefined
  const options: PermissionOption[] = []
  for (const entry of value) {
    const option = object(entry)
    if (
      option === undefined ||
      typeof option.id !== 'string' ||
      typeof option.label !== 'string' ||
      !isPermissionKind(option.kind)
    )
      return undefined
    options.push({ id: option.id, label: option.label, kind: option.kind })
  }
  return options
}

export function parseUserQuestion(value: Record<string, unknown>): UserQuestion | undefined {
  const choices = value.choices === undefined ? undefined : questionChoices(value.choices)
  const intent = questionIntent(value.intent)
  const items = value.items === undefined ? undefined : questionItems(value.items)
  if (
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.sessionId) ||
    typeof value.prompt !== 'string' ||
    typeof value.allowFreeText !== 'boolean' ||
    (value.rpcId !== undefined && typeof value.rpcId !== 'string') ||
    (value.detail !== undefined && typeof value.detail !== 'string') ||
    (value.header !== undefined && typeof value.header !== 'string') ||
    (value.choices !== undefined && choices === undefined) ||
    (value.multiSelect !== undefined && typeof value.multiSelect !== 'boolean') ||
    (value.intent !== undefined && intent === undefined) ||
    (value.items !== undefined && items === undefined)
  )
    return undefined
  return {
    id: value.id,
    ...(value.rpcId === undefined ? {} : { rpcId: value.rpcId }),
    sessionId: value.sessionId,
    prompt: value.prompt,
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    ...(value.header === undefined ? {} : { header: value.header }),
    ...(choices === undefined ? {} : { choices }),
    ...(value.multiSelect === undefined ? {} : { multiSelect: value.multiSelect }),
    allowFreeText: value.allowFreeText,
    ...(intent === undefined ? {} : { intent }),
    ...(items === undefined ? {} : { items }),
  }
}

export function questionChoices(value: unknown): readonly QuestionChoice[] | undefined {
  if (!Array.isArray(value)) return undefined
  const choices: QuestionChoice[] = []
  for (const entry of value) {
    const choice = object(entry)
    if (
      choice === undefined ||
      typeof choice.id !== 'string' ||
      typeof choice.label !== 'string' ||
      (choice.description !== undefined && typeof choice.description !== 'string')
    )
      return undefined
    choices.push({
      id: choice.id,
      label: choice.label,
      ...(choice.description === undefined ? {} : { description: choice.description }),
    })
  }
  return choices
}

export function questionItems(value: unknown): readonly UserQuestionItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (value.length === 0) return undefined
  const items: UserQuestionItem[] = []
  for (const entry of value) {
    const item = questionItem(entry)
    if (item === undefined) return undefined
    items.push(item)
  }
  return items
}

export function questionItem(value: unknown): UserQuestionItem | undefined {
  const item = object(value)
  if (item === undefined) return undefined
  const choices = item.choices === undefined ? undefined : questionChoices(item.choices)
  const intent = questionIntent(item.intent)
  if (
    typeof item.id !== 'string' ||
    typeof item.prompt !== 'string' ||
    typeof item.allowFreeText !== 'boolean' ||
    (item.detail !== undefined && typeof item.detail !== 'string') ||
    (item.header !== undefined && typeof item.header !== 'string') ||
    (item.choices !== undefined && choices === undefined) ||
    (item.multiSelect !== undefined && typeof item.multiSelect !== 'boolean') ||
    (item.intent !== undefined && intent === undefined)
  )
    return undefined
  return {
    id: item.id,
    prompt: item.prompt,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    ...(item.header === undefined ? {} : { header: item.header }),
    ...(choices === undefined ? {} : { choices }),
    ...(item.multiSelect === undefined ? {} : { multiSelect: item.multiSelect }),
    allowFreeText: item.allowFreeText,
    ...(intent === undefined ? {} : { intent }),
  }
}

export function questionIntent(value: unknown): QuestionIntent | undefined {
  if (value === undefined) return undefined
  const intent = object(value)
  if (intent === undefined || intent.kind !== 'plan-review' || typeof intent.approve !== 'string')
    return undefined
  return { kind: 'plan-review', approve: intent.approve }
}

export function isPermissionRisk(value: unknown): value is PermissionRequest['risk'] {
  return value === 'unknown' || value === 'low' || value === 'medium' || value === 'high'
}

export function isToolMode(value: unknown): value is AgentConfiguration['toolMode'] {
  return value === 'native' || value === 'ptc' || value === 'code' || value === 'both'
}

export function isGoalView(value: unknown): value is GoalView {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    isGoalStatus(item.status) &&
    (item.activation === undefined || item.activation === 'armed' || item.activation === 'disarmed') &&
    (item.maxGoalRounds === undefined || positiveSafeInteger(item.maxGoalRounds) !== undefined) &&
    (item.blockedReason === undefined || isGoalBlockedReason(item.blockedReason))
  )
}

export function isGoalBlockedReason(
  value: unknown,
): value is { readonly code: string; readonly message: string } {
  const reason = object(value)
  return reason !== undefined && typeof reason.code === 'string' && typeof reason.message === 'string'
}

export function parseGoalViews(value: unknown): readonly GoalView[] | undefined {
  if (!Array.isArray(value)) return undefined
  const goals: GoalView[] = []
  for (const entry of value) {
    if (!isGoalView(entry)) return undefined
    goals.push(entry)
  }
  return goals
}

export function parseTodoViews(value: unknown): readonly TodoView[] | undefined {
  if (!Array.isArray(value)) return undefined
  const todos: TodoView[] = []
  for (const entry of value) {
    const item = object(entry)
    if (
      item === undefined ||
      typeof item.id !== 'string' ||
      item.id.length === 0 ||
      typeof item.content !== 'string' ||
      (item.status !== 'pending' && item.status !== 'in-progress' && item.status !== 'completed')
    )
      return undefined
    todos.push({ id: item.id, content: item.content, status: item.status })
  }
  return todos
}

export function parseQueuedInputs(value: unknown, sessionId: string): readonly QueuedInput[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items: QueuedInput[] = []
  for (const entry of value) {
    if (!isQueuedInput(entry)) return undefined
    if (entry.sessionId !== sessionId) return undefined
    items.push(entry)
  }
  return items
}

export function isJobView(value: unknown): value is JobView {
  const item = object(value)
  const output = object(item?.output)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.kind === 'string' &&
    item.kind.length > 0 &&
    typeof item.label === 'string' &&
    item.label.length > 0 &&
    isJobStatus(item.status) &&
    Number.isSafeInteger(item.startedAt) &&
    (item.startedAt as number) >= 0 &&
    (item.detail === undefined || typeof item.detail === 'string') &&
    (item.progress === undefined || typeof item.progress === 'string') &&
    (item.output === undefined ||
      (output !== undefined &&
        Number.isSafeInteger(output.total) &&
        (output.total as number) >= 0 &&
        Number.isSafeInteger(output.earliest) &&
        (output.earliest as number) >= 0 &&
        (output.earliest as number) <= (output.total as number))) &&
    (item.finishedAt === undefined ||
      (Number.isSafeInteger(item.finishedAt) && (item.finishedAt as number) >= 0))
  )
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

export function isQueuedInput(value: unknown): value is QueuedInput {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    item.id.trim() !== '' &&
    typeof item.sessionId === 'string' &&
    item.sessionId.trim() !== '' &&
    typeof item.text === 'string' &&
    Array.isArray(item.attachments) &&
    item.attachments.every(isPromptAttachment) &&
    (item.images === undefined ||
      (Array.isArray(item.images) && item.images.every(isMessageImageReference))) &&
    (item.files === undefined ||
      (Array.isArray(item.files) &&
        item.files.every((entry) => typeof entry === 'string' && entry.trim() !== ''))) &&
    typeof item.textOnly === 'boolean' &&
    (item.mode === 'queue' || item.mode === 'steer') &&
    typeof item.createdAt === 'string' &&
    (item.rpcId === undefined || typeof item.rpcId === 'string')
  )
}

export function isPromptAttachment(value: unknown): value is PromptAttachment {
  const attachment = object(value)
  return (
    attachment !== undefined &&
    typeof attachment.uri === 'string' &&
    typeof attachment.name === 'string' &&
    (attachment.mimeType === undefined || typeof attachment.mimeType === 'string')
  )
}

export function isMessageImageReference(value: unknown): value is MessageImageReference {
  const image = object(value)
  return (
    image !== undefined &&
    typeof image.attachmentId === 'string' &&
    image.attachmentId.trim() !== '' &&
    (image.mediaType === 'image/png' ||
      image.mediaType === 'image/jpeg' ||
      image.mediaType === 'image/webp' ||
      image.mediaType === 'image/gif') &&
    positiveSafeInteger(image.bytes) !== undefined &&
    positiveSafeInteger(image.width) !== undefined &&
    positiveSafeInteger(image.height) !== undefined &&
    (image.name === undefined || typeof image.name === 'string')
  )
}
const WORKFLOW_STATUSES: readonly string[] = ['running', 'completed', 'failed', 'cancelled', 'interrupted']
const MEMBER_STATUSES: readonly string[] = ['running', 'completed', 'failed', 'cancelled', 'interrupted']
