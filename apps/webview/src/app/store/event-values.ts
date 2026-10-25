import {
  type AgentConfiguration,
  type GoalView,
  type JobView,
  type MessageImageReference,
  type PermissionRequest,
  type PermissionOption,
  type PromptAttachment,
  type QuestionChoice,
  type QuestionIntent,
  type QueuedInput,
  type SessionConfigurationPatch,
  type SessionProjectionSnapshot,
  type TurnEndFailure,
  type TodoView,
  type TurnEndReasonKind,
  type UserQuestion,
  type UserQuestionItem,
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
    object(projection.values) === undefined ||
    !validTodoProjectionValues(object(projection.values) ?? {})
  )
    throw new Error(translate('app.error.malformedProjection'))
  return {
    asOfSequence: projection.asOfSequence as number,
    values: projection.values as Readonly<Record<string, unknown>>,
  }
}

export function validTodoProjectionValues(values: Readonly<Record<string, unknown>>): boolean {
  return (
    !Object.hasOwn(values, 'todoList') ||
    values.todoList === null ||
    parseTodoViews(values.todoList) !== undefined
  )
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

export function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
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
    (value.timed !== undefined && typeof value.timed !== 'boolean') ||
    (value.state !== undefined && value.state !== 'open' && value.state !== 'continued') ||
    (value.replyQueued !== undefined && typeof value.replyQueued !== 'boolean') ||
    (value.callId !== undefined && !nonEmptyString(value.callId)) ||
    (value.commandLine !== undefined && typeof value.commandLine !== 'string')
  )
    return undefined
  return {
    id: value.id,
    ...(value.rpcId === undefined ? {} : { rpcId: value.rpcId }),
    ...(value.callId === undefined ? {} : { callId: value.callId }),
    ...(value.timed === undefined ? {} : { timed: value.timed }),
    ...(value.state === undefined ? {} : { state: value.state }),
    ...(value.replyQueued === undefined ? {} : { replyQueued: value.replyQueued }),
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
    (value.items !== undefined && items === undefined) ||
    (value.callId !== undefined && !nonEmptyString(value.callId)) ||
    (value.timed !== undefined && typeof value.timed !== 'boolean') ||
    (value.state !== undefined && value.state !== 'open' && value.state !== 'continued') ||
    (value.replyQueued !== undefined && typeof value.replyQueued !== 'boolean')
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
    ...(typeof value.callId === 'string' ? { callId: value.callId } : {}),
    ...(typeof value.timed === 'boolean' ? { timed: value.timed } : {}),
    ...(value.state === 'open' || value.state === 'continued' ? { state: value.state } : {}),
    ...(typeof value.replyQueued === 'boolean' ? { replyQueued: value.replyQueued } : {}),
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
