import type {
  AgentPresetDescriptor,
  BackendEvent,
  GoalView,
  JobView,
  MessageImageReference,
  ModelCatalogFailure,
  ModelDescriptor,
  ModelProvider,
  ModelReasoningLevel,
  PromptAttachment,
  QueuedInput,
  SessionSummary,
  TodoView,
  WorkspaceSummary,
} from '@dsh-vscode/domain'
import { object } from './unknown-record.js'

export function strictListValues<T>(
  value: unknown,
  guard: (value: unknown) => value is T,
): readonly T[] | undefined {
  const values = Array.isArray(value) ? value : object(value)?.items
  if (!Array.isArray(values) || !values.every(guard)) return undefined
  return values
}

/**
 * Provider discovery is a mixed live/configurable directory. Keep valid rows
 * when an optional catalog row is malformed so one bad upstream entry cannot
 * hide the live providers that the user can actually use.
 */
export function listValues(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value
  const record = object(value)
  return Array.isArray(record?.items) ? record.items : []
}

export function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every((entry): entry is string => typeof entry === 'string') ? value : undefined
}

export function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)]
}

export function mergeUniqueStrings(
  current: readonly string[],
  additions: readonly string[],
): readonly string[] {
  const seen = new Set(current)
  let next: string[] | undefined
  for (const value of additions) {
    if (seen.has(value)) continue
    seen.add(value)
    if (next === undefined) next = [...current]
    next.push(value)
  }
  return next ?? current
}

export function deduplicateSessionSummaries(sessions: readonly SessionSummary[]): readonly SessionSummary[] {
  const seen = new Set<string>()
  const unique: SessionSummary[] = []
  for (const session of sessions) {
    if (seen.has(session.id)) continue
    seen.add(session.id)
    unique.push(session)
  }
  return unique
}

export function sameSessionSummaryList(
  left: readonly SessionSummary[],
  right: readonly SessionSummary[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index]
    const next = right[index]
    if (previous === undefined || next === undefined || !sameSessionSummary(previous, next)) return false
  }
  return true
}

export function sameSessionSummary(left: SessionSummary, right: SessionSummary): boolean {
  return (
    left.id === right.id &&
    left.workspaceId === right.workspaceId &&
    left.workspaceFolderId === right.workspaceFolderId &&
    left.title === right.title &&
    left.blank === right.blank &&
    left.parentSessionId === right.parentSessionId &&
    left.origin === right.origin &&
    left.agentAvailable === right.agentAvailable &&
    left.status === right.status &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.modelLabel === right.modelLabel &&
    left.agentPreset === right.agentPreset &&
    sameSessionProjection(left.projection, right.projection)
  )
}

export function sameSessionProjection(
  left: SessionSummary['projection'],
  right: SessionSummary['projection'],
): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined || left.asOfSequence !== right.asOfSequence) return false
  const leftKeys = Object.keys(left.values)
  const rightKeys = Object.keys(right.values)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) if (!Object.is(left.values[key], right.values[key])) return false
  return true
}

export function sameWorkspaceSummaryList(
  left: readonly WorkspaceSummary[],
  right: readonly WorkspaceSummary[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index]
    const next = right[index]
    if (previous === undefined || next === undefined || !sameWorkspaceSummary(previous, next)) return false
  }
  return true
}

export function sameWorkspaceSummary(left: WorkspaceSummary, right: WorkspaceSummary): boolean {
  if (
    left.id !== right.id ||
    left.name !== right.name ||
    left.createdAt !== right.createdAt ||
    left.updatedAt !== right.updatedAt ||
    left.sessionCount !== right.sessionCount
  )
    return false
  const leftSessionIds = left.sessionIds
  const rightSessionIds = right.sessionIds
  if (leftSessionIds === rightSessionIds) return true
  if (leftSessionIds === undefined || rightSessionIds === undefined) return leftSessionIds === rightSessionIds
  if (leftSessionIds.length !== rightSessionIds.length) return false
  return leftSessionIds.every((sessionId, index) => sessionId === rightSessionIds[index])
}

export function sameModelProviderList(
  left: readonly ModelProvider[],
  right: readonly ModelProvider[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index]
    const next = right[index]
    if (previous === undefined || next === undefined || !sameModelProvider(previous, next)) return false
  }
  return true
}

export function sameModelProvider(left: ModelProvider, right: ModelProvider): boolean {
  if (
    left.id !== right.id ||
    left.name !== right.name ||
    left.kind !== right.kind ||
    left.configurable !== right.configurable ||
    left.active !== right.active ||
    left.declared !== right.declared ||
    left.settingsNs !== right.settingsNs ||
    !sameStringList(left.settingsPath, right.settingsPath) ||
    left.fields.length !== right.fields.length
  )
    return false
  for (let index = 0; index < left.fields.length; index += 1) {
    const previous = left.fields[index]
    const next = right.fields[index]
    if (
      previous === undefined ||
      next === undefined ||
      previous.key !== next.key ||
      previous.label !== next.label ||
      previous.secret !== next.secret ||
      previous.required !== next.required ||
      !sameStringList(previous.enumValues, next.enumValues) ||
      previous.writable !== next.writable ||
      previous.value !== next.value
    )
      return false
  }
  return true
}

export function sameModelDescriptorList(
  left: readonly ModelDescriptor[],
  right: readonly ModelDescriptor[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index]
    const next = right[index]
    if (
      previous === undefined ||
      next === undefined ||
      previous.id !== next.id ||
      previous.providerId !== next.providerId ||
      previous.label !== next.label ||
      previous.contextWindow !== next.contextWindow ||
      !sameStringList(previous.inputModalities, next.inputModalities) ||
      previous.supportsReasoning !== next.supportsReasoning ||
      previous.defaultReasoningLevel !== next.defaultReasoningLevel ||
      !sameReasoningLevelList(previous.reasoningLevels, next.reasoningLevels)
    )
      return false
  }
  return true
}

export function sameModelCatalogFailureList(
  left: readonly ModelCatalogFailure[],
  right: readonly ModelCatalogFailure[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index]
    const next = right[index]
    if (
      previous === undefined ||
      next === undefined ||
      previous.providerId !== next.providerId ||
      previous.providerName !== next.providerName ||
      previous.message !== next.message
    )
      return false
  }
  return true
}

export function samePresetDescriptorList(
  left: readonly AgentPresetDescriptor[],
  right: readonly AgentPresetDescriptor[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index]
    const next = right[index]
    if (
      previous === undefined ||
      next === undefined ||
      previous.id !== next.id ||
      previous.trust !== next.trust ||
      previous.isDefault !== next.isDefault ||
      previous.name !== next.name ||
      previous.description !== next.description ||
      previous.broken !== next.broken
    )
      return false
  }
  return true
}

export function sameStringList(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined || left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

/**
 * The seat names an effort with the adapter's label and sends its id back, so
 * both halves belong to the identity of an advertised level.
 */
export function sameReasoningLevelList(
  left: readonly ModelReasoningLevel[] | undefined,
  right: readonly ModelReasoningLevel[] | undefined,
): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined || left.length !== right.length) return false
  return left.every((level, index) => level.id === right[index]?.id && level.label === right[index]?.label)
}
export function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

export function removeMatching<T>(items: readonly T[], matches: (item: T) => boolean): readonly T[] {
  const firstMatch = items.findIndex(matches)
  if (firstMatch === -1) return items
  return items.filter((item) => !matches(item))
}

export function sameQueuedInputList(left: readonly QueuedInput[], right: readonly QueuedInput[]): boolean {
  return sameList(
    left,
    right,
    (previous, next) =>
      previous.id === next.id &&
      previous.sessionId === next.sessionId &&
      previous.text === next.text &&
      previous.mode === next.mode &&
      previous.createdAt === next.createdAt &&
      previous.rpcId === next.rpcId &&
      previous.textOnly === next.textOnly &&
      samePromptAttachmentList(previous.attachments, next.attachments) &&
      sameMessageImageList(previous.images, next.images) &&
      sameStringList(previous.files, next.files),
  )
}

export function removeAdmittedQueueInput(
  queue: readonly QueuedInput[],
  event: Extract<BackendEvent, { readonly type: 'message.user' }>,
): readonly QueuedInput[] {
  const byRpcId = event.rpcId === undefined ? -1 : queue.findIndex((item) => item.rpcId === event.rpcId)
  const index = byRpcId >= 0 ? byRpcId : queue.findIndex((item) => isAdmittedQueueInput(item, event))
  if (index < 0) return queue
  return [...queue.slice(0, index), ...queue.slice(index + 1)]
}

/**
 * Whether a pending row is the durable message that was just admitted.
 *
 * The two are projections of the same host content, but not of the same
 * fields: the row lists the names of the files it carries — an inlined text
 * file among them — while the durable message reports those names as
 * attachments, and its images are compared by count. Comparing the two lists
 * field by field therefore never matched a row that carried anything, and the
 * dock kept the row until the next queue frame. Correspondence by kind is what
 * identifies the message, mirroring the timeline's preview matcher.
 *
 * The durable message may carry attachments the row never listed: editor
 * context chips are resolved into prompt attachments inside the Extension Host
 * and are appended after the row's own, so the row's names are the leading
 * ones and anything beyond them belongs to content the Webview never queued.
 */
export function isAdmittedQueueInput(
  item: QueuedInput,
  event: Extract<BackendEvent, { readonly type: 'message.user' }>,
): boolean {
  if (item.text !== event.markdown) return false
  const names = item.files ?? []
  const attachedNames = (event.attachments ?? []).map((attachment) => attachment.name)
  if (names.length > attachedNames.length) return false
  if (!names.every((name, index) => name === attachedNames[index])) return false
  return (item.images ?? []).length === (event.images ?? []).length
}

export function samePromptAttachmentList(
  left: readonly PromptAttachment[],
  right: readonly PromptAttachment[],
): boolean {
  return sameList(
    left,
    right,
    (previous, next) =>
      previous.uri === next.uri && previous.name === next.name && previous.mimeType === next.mimeType,
  )
}

export function sameMessageImageList(
  queued: readonly MessageImageReference[] | undefined,
  message: readonly MessageImageReference[] | undefined,
): boolean {
  const left = queued ?? []
  const right = message ?? []
  return (
    left.length === right.length &&
    left.every(
      (image, index) =>
        image.attachmentId === right[index]?.attachmentId &&
        image.mediaType === right[index]?.mediaType &&
        image.bytes === right[index]?.bytes &&
        image.width === right[index]?.width &&
        image.height === right[index]?.height &&
        image.name === right[index]?.name,
    )
  )
}

export function sameGoalList(left: readonly GoalView[], right: readonly GoalView[]): boolean {
  return sameList(
    left,
    right,
    (previous, next) =>
      previous.id === next.id &&
      previous.title === next.title &&
      previous.status === next.status &&
      previous.maxGoalRounds === next.maxGoalRounds &&
      previous.activation === next.activation &&
      // The host can republish a still-blocked goal with a different reason;
      // comparing only status would keep showing the superseded one.
      previous.blockedReason?.code === next.blockedReason?.code &&
      previous.blockedReason?.message === next.blockedReason?.message,
  )
}

export function sameTodoList(left: readonly TodoView[], right: readonly TodoView[]): boolean {
  return sameList(
    left,
    right,
    (previous, next) =>
      previous.id === next.id && previous.content === next.content && previous.status === next.status,
  )
}

export function sameJobList(left: readonly JobView[], right: readonly JobView[]): boolean {
  return sameList(
    left,
    right,
    (previous, next) =>
      previous.id === next.id &&
      previous.kind === next.kind &&
      previous.label === next.label &&
      previous.status === next.status &&
      previous.detail === next.detail &&
      previous.progress === next.progress &&
      previous.startedAt === next.startedAt &&
      previous.finishedAt === next.finishedAt &&
      previous.output?.total === next.output?.total &&
      previous.output?.earliest === next.output?.earliest,
  )
}

export function sameList<T>(
  left: readonly T[],
  right: readonly T[],
  equal: (previous: T, next: T) => boolean,
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index]
    const next = right[index]
    if (previous === undefined || next === undefined || !equal(previous, next)) return false
  }
  return true
}
