import type {
  ChangeDetail,
  ChangeSetFile,
  CheckpointPreview,
  CheckpointSummary,
  FeatureEventIdentity,
  FeedbackCategory,
  MessageFeedbackItem,
  PromptTemplate,
  PromptTemplateInsertion,
  PromptTemplateSummary,
  TaskListScope,
  TaskSummary,
} from '@dsh-vscode/domain'
import { featureResponseSchema, type FeatureResponse } from '@dsh-vscode/webview-protocol'
import { object } from './unknown-record.js'

type FeatureSuccessResponse = Extract<FeatureResponse, { readonly ok: true }>
type FeatureResponsePayload = FeatureSuccessResponse['payload']
type FeatureChangeSummary = Extract<FeatureResponsePayload, { readonly kind: 'changes' }>['items'][number]
type FeatureChangeDetailPayload = Extract<FeatureResponsePayload, { readonly kind: 'change.detail' }>
type FeatureTaskList = Extract<FeatureResponsePayload, { readonly kind: 'tasks' }>
type FeatureTaskSummary = Extract<FeatureResponsePayload, { readonly kind: 'tasks' }>['items'][number]
type FeatureCheckpointSummary = Extract<
  FeatureResponsePayload,
  { readonly kind: 'checkpoints' }
>['items'][number]
type FeatureCheckpointPreview = Extract<
  FeatureResponsePayload,
  { readonly kind: 'checkpoint.preview' }
>['preview']
type FeaturePromptTemplateSummary = Extract<
  FeatureResponsePayload,
  { readonly kind: 'prompt.templates' }
>['items'][number]
type FeaturePromptTemplate = Extract<FeatureResponsePayload, { readonly kind: 'prompt.template' }>['template']
type FeaturePromptTemplateInsertion = Extract<
  FeatureResponsePayload,
  { readonly kind: 'prompt.template.inserted' }
>
type FeatureOperationPayload = Extract<FeatureResponsePayload, { readonly kind: 'operation' }>

export function parseFeatureTasksResult(value: unknown):
  | {
      readonly items: readonly TaskSummary[]
      readonly scope: TaskListScope
      readonly complete: boolean
      readonly omittedSessions: number
    }
  | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'store-parse',
    ok: true,
    payload: value,
  })
  if (!parsed.success || parsed.data.ok !== true || parsed.data.payload.kind !== 'tasks') return undefined
  const payload: FeatureTaskList = parsed.data.payload
  return {
    items: payload.items.map(parseFeatureTaskSummary),
    scope: payload.scope,
    complete: payload.complete,
    omittedSessions: payload.omittedSessions,
  }
}

export function parseFeatureCheckpointsResult(value: unknown): readonly CheckpointSummary[] | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'store-parse',
    ok: true,
    payload: value,
  })
  if (!parsed.success || parsed.data.ok !== true || parsed.data.payload.kind !== 'checkpoints')
    return undefined
  return parsed.data.payload.items.map(parseFeatureCheckpointSummary)
}

function parseFeatureCheckpointSummary(item: FeatureCheckpointSummary): CheckpointSummary {
  return {
    checkpointId: item.checkpointId,
    sessionId: item.sessionId,
    workspaceFolderId: item.workspaceFolderId,
    createdAt: item.createdAt,
    ...(item.label === undefined ? {} : { label: item.label }),
    fileCount: item.fileCount,
    totalBytes: item.totalBytes,
    state: item.state,
    restoreAllowed: item.restoreAllowed,
    contentEnabled: item.contentEnabled,
    ...(item.expectedRevision === undefined ? {} : { expectedRevision: item.expectedRevision }),
  }
}

export function parseFeatureCheckpointPreviewResult(value: unknown): CheckpointPreview | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'store-parse',
    ok: true,
    payload: value,
  })
  if (!parsed.success || parsed.data.ok !== true || parsed.data.payload.kind !== 'checkpoint.preview')
    return undefined
  const preview: FeatureCheckpointPreview = parsed.data.payload.preview
  return {
    previewId: preview.previewId,
    summary: parseFeatureCheckpointSummary(preview.summary),
    files: preview.files.map((file) => ({
      relativePath: file.relativePath,
      presentAtCheckpoint: file.presentAtCheckpoint,
      ...(file.expectedCurrentHash === undefined ? {} : { expectedCurrentHash: file.expectedCurrentHash }),
      ...(file.currentHash === undefined ? {} : { currentHash: file.currentHash }),
      conflict: file.conflict,
      byteSize: file.byteSize,
    })),
    conflictCount: preview.conflictCount,
  }
}

export function parseFeaturePromptTemplatesResult(
  value: unknown,
): readonly PromptTemplateSummary[] | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'store-parse',
    ok: true,
    payload: value,
  })
  if (!parsed.success || parsed.data.ok !== true || parsed.data.payload.kind !== 'prompt.templates')
    return undefined
  return parsed.data.payload.items.map(parseFeaturePromptTemplateSummary)
}

function parseFeaturePromptTemplateSummary(item: FeaturePromptTemplateSummary): PromptTemplateSummary {
  return {
    templateId: item.templateId,
    title: item.title,
    description: item.description,
    scope: item.scope,
    updatedAt: item.updatedAt,
    variables: [...item.variables],
    enabled: item.enabled,
  }
}

export function parseFeaturePromptTemplateResult(value: unknown): PromptTemplate | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'store-parse',
    ok: true,
    payload: value,
  })
  if (!parsed.success || parsed.data.ok !== true || parsed.data.payload.kind !== 'prompt.template')
    return undefined
  const template: FeaturePromptTemplate = parsed.data.payload.template
  return {
    ...parseFeaturePromptTemplateSummary(template.summary),
    templateText: template.templateText,
  }
}

export function parseFeaturePromptTemplateInsertionResult(
  value: unknown,
): PromptTemplateInsertion | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'store-parse',
    ok: true,
    payload: value,
  })
  if (!parsed.success || parsed.data.ok !== true || parsed.data.payload.kind !== 'prompt.template.inserted')
    return undefined
  const insertion: FeaturePromptTemplateInsertion = parsed.data.payload
  return {
    templateId: insertion.templateId,
    text: insertion.text,
    unresolvedVariables: [...insertion.unresolvedVariables],
  }
}

export function parseFeatureOperationResult(value: unknown): FeatureOperationPayload | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'store-parse',
    ok: true,
    payload: value,
  })
  if (!parsed.success || parsed.data.ok !== true || parsed.data.payload.kind !== 'operation') return undefined
  return parsed.data.payload
}

function parseFeatureTaskSummary(item: FeatureTaskSummary): TaskSummary {
  return {
    taskId: item.taskId,
    sourceId: item.sourceId,
    ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
    ...(item.parentTaskId === undefined ? {} : { parentTaskId: item.parentTaskId }),
    workspaceFolderId: item.workspaceFolderId,
    kind: item.kind,
    title: item.title,
    ...(item.sessionTitle === undefined ? {} : { sessionTitle: item.sessionTitle }),
    status: item.status,
    needsUserAction: item.needsUserAction,
    ...(item.actionKind === undefined ? {} : { actionKind: item.actionKind }),
    ...(item.interactionId === undefined ? {} : { interactionId: item.interactionId }),
    ...(item.modelLabel === undefined ? {} : { modelLabel: item.modelLabel }),
    ...(item.providerLabel === undefined ? {} : { providerLabel: item.providerLabel }),
    startedAt: item.startedAt,
    updatedAt: item.updatedAt,
    ...(item.progress === undefined ? {} : { progress: item.progress }),
    childCount: item.childCount,
    canOpen: item.canOpen,
    canAnswer: item.canAnswer,
    canSessionCancel: item.canSessionCancel,
    ownerKind: item.ownerKind,
    ...(item.backendInstanceId === undefined ? {} : { backendInstanceId: item.backendInstanceId }),
    ...(item.connectionGeneration === undefined ? {} : { connectionGeneration: item.connectionGeneration }),
    taskRevision: item.taskRevision,
  }
}

export function mergeTask(tasks: readonly TaskSummary[], task: TaskSummary): readonly TaskSummary[] {
  const index = tasks.findIndex((entry) => entry.taskId === task.taskId)
  if (index < 0) return [...tasks, task]
  return tasks.map((entry, entryIndex) => (entryIndex === index ? task : entry))
}

export function parseFeatureChangesResult(value: unknown): readonly ChangeSetFile[] | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'store-parse',
    ok: true,
    payload: value,
  })
  if (!parsed.success || !('payload' in parsed.data) || parsed.data.ok !== true) return undefined
  const payload = parsed.data.payload
  if (payload.kind !== 'changes') return undefined
  return payload.items.map(parseFeatureChangeSummary)
}

export function parseFeatureChangeDetail(value: unknown): ChangeDetail | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'store-parse',
    ok: true,
    payload: value,
  })
  if (!parsed.success || !('payload' in parsed.data) || parsed.data.ok !== true) return undefined
  const responsePayload = parsed.data.payload
  if (responsePayload.kind !== 'change.detail') return undefined
  const payload: FeatureChangeDetailPayload = responsePayload
  const summary = parseFeatureChangeSummary(payload.change)
  return {
    ...summary,
    ...(payload.redactedDiff === undefined ? {} : { redactedDiff: payload.redactedDiff }),
    diffTruncated: payload.truncated === true,
  }
}

function parseFeatureChangeSummary(item: FeatureChangeSummary): ChangeSetFile {
  return {
    changeId: item.changeId,
    sessionId: item.sessionId,
    workspaceFolderId: item.workspaceFolderId,
    relativePath: item.relativePath,
    ...(item.previousRelativePath === undefined ? {} : { previousRelativePath: item.previousRelativePath }),
    status: item.status,
    ...(item.additions === undefined ? {} : { additions: item.additions }),
    ...(item.deletions === undefined ? {} : { deletions: item.deletions }),
    locations: item.locations.map((location) => ({
      path: location.relativePath,
      ...(location.line === undefined ? {} : { line: location.line }),
    })),
    evidence: fromFeatureChangeEvidence(item.evidence),
    applicationState: fromFeatureChangeApplicationState(item.applicationState),
    reviewState: item.reviewState,
    sourceIds: [...item.sourceIds],
    sourceInteractionIds: [],
    sourceToolCallIds: [...item.sourceIds],
    firstSeenAt: item.firstSeenAt,
    lastSeenAt: item.lastSeenAt,
    identity: featureEventIdentity(item.identity),
    diffAvailable: item.diffAvailable,
  }
}

function featureEventIdentity(value: FeatureChangeSummary['identity']): FeatureEventIdentity {
  const optional = {
    ...(value.eventId === undefined ? {} : { eventId: value.eventId }),
    ...(value.rpcId === undefined ? {} : { rpcId: value.rpcId }),
    ...(value.toolCallId === undefined ? {} : { toolCallId: value.toolCallId }),
  }
  if (value.stream === 'mux')
    return {
      ...optional,
      backendInstanceId: value.backendInstanceId,
      connectionGeneration: value.connectionGeneration,
      stream: 'mux',
      sessionId: value.sessionId,
      serverSeq: value.serverSeq,
    }
  return {
    ...optional,
    backendInstanceId: value.backendInstanceId,
    connectionGeneration: value.connectionGeneration,
    stream: value.stream,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    localSeq: value.localSeq,
  }
}

function fromFeatureChangeEvidence(evidence: FeatureChangeSummary['evidence']): ChangeSetFile['evidence'] {
  switch (evidence) {
    case 'structured-proposal':
      return 'structuredProposal'
    case 'structured-tool-success':
      return 'structuredToolSuccess'
    case 'filesystem-observed':
      return 'filesystemObserved'
    case 'structured-location-only':
      return 'structuredLocationOnly'
    case 'failed':
      return 'failed'
    case 'incomplete':
      return 'incomplete'
  }
  return 'incomplete'
}

function fromFeatureChangeApplicationState(
  state: FeatureChangeSummary['applicationState'],
): ChangeSetFile['applicationState'] {
  switch (state) {
    case 'proposed':
      return 'proposed'
    case 'applied-observed':
      return 'appliedObserved'
    case 'failed':
      return 'failed'
    case 'unknown':
      return 'unknown'
  }
  return 'unknown'
}
export function isMessageFeedbackItem(value: unknown): value is MessageFeedbackItem {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.messageId === 'string' &&
    item.messageId.length > 0 &&
    (item.rating === 'positive' || item.rating === 'negative') &&
    typeof item.version === 'string' &&
    item.version.length > 0 &&
    (item.note === undefined || typeof item.note === 'string') &&
    (item.category === undefined || isFeedbackCategory(item.category)) &&
    (item.createdAt === undefined ||
      (typeof item.createdAt === 'number' && Number.isSafeInteger(item.createdAt) && item.createdAt >= 0)) &&
    (item.updatedAt === undefined ||
      (typeof item.updatedAt === 'number' && Number.isSafeInteger(item.updatedAt) && item.updatedAt >= 0))
  )
}

export function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return (
    value === 'task-result' ||
    value === 'instruction-following' ||
    value === 'product-interaction' ||
    value === 'service-stability' ||
    value === 'resource-cost' ||
    value === 'security-privacy-permission' ||
    value === 'other'
  )
}

export function feedbackRecord(
  items: readonly MessageFeedbackItem[],
): Readonly<Record<string, MessageFeedbackItem>> {
  return Object.fromEntries(items.map((item) => [item.messageId, item]))
}
