import { z } from 'zod'

/**
 * Strict schemas for the staged editor/review/task/recovery surface.
 *
 * These messages are intentionally separate from the legacy generic event
 * envelope. Until a route is implemented, the active Host router does not
 * accept these request names. Keeping the schemas closed now prevents a
 * future route from accidentally falling back to `boundedUnknown`.
 */

const id = z.string().min(1).max(256)
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positiveTimestamp = timestamp.refine((value) => value > 0, 'Timestamp must be positive.')
const boundedText = z.string().max(16_000_000)
const safeLabel = z.string().min(1).max(512)
const MAX_CONTEXT_ITEMS = 8
const MAX_CONTEXT_ITEM_BYTES = 64 * 1024
const MAX_CONTEXT_TOTAL_BYTES = 256 * 1024

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 1_024) return false
  if (value.includes('\\') || value.includes(':') || value.startsWith('/') || /^[A-Za-z]:/u.test(value))
    return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return false
  if (containsControlCharacters(value)) return false
  const segments = value.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export const featureRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isSafeRelativePath, 'Only canonical workspace-relative paths are allowed.')

export const featureResourceScopeSchema = z
  .object({
    ownerId: id,
    workspaceFolderId: id,
    ownerViewId: id.optional(),
    sessionId: id.optional(),
    backendInstanceId: id.optional(),
    connectionGeneration: generation.optional(),
    expiresAt: positiveTimestamp,
  })
  .strict()

const featureEventIdentityBase = {
  backendInstanceId: id,
  connectionGeneration: generation,
  eventId: id.optional(),
  rpcId: id.optional(),
  toolCallId: id.optional(),
}

export const featureEventIdentitySchema = z.discriminatedUnion('stream', [
  z
    .object({
      ...featureEventIdentityBase,
      stream: z.literal('mux'),
      sessionId: id,
      serverSeq: generation,
    })
    .strict(),
  z
    .object({
      ...featureEventIdentityBase,
      stream: z.literal('host'),
      sessionId: id.optional(),
      localSeq: generation,
    })
    .strict(),
  z
    .object({
      ...featureEventIdentityBase,
      stream: z.literal('local'),
      sessionId: id.optional(),
      localSeq: generation,
    })
    .strict(),
])

const featurePositionSchema = z
  .object({
    line: z.number().int().nonnegative().max(1_000_000),
    column: z.number().int().nonnegative().max(1_000_000),
  })
  .strict()

export const featureRangeSchema = z
  .object({
    start: featurePositionSchema,
    end: featurePositionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.start.line > value.end.line ||
      (value.start.line === value.end.line && value.start.column > value.end.column)
    ) {
      context.addIssue({ code: 'custom', path: ['end'], message: 'Range end must not precede range start.' })
    }
  })

export const editorContextItemSchema = z
  .object({
    contextRef: id,
    kind: z.enum(['selection', 'open-document', 'diagnostic', 'symbol']),
    label: safeLabel,
    workspaceFolderId: id,
    relativePath: featureRelativePathSchema,
    range: featureRangeSchema.optional(),
    sizeBytes: z.number().int().nonnegative().max(MAX_CONTEXT_ITEM_BYTES),
    documentVersion: generation.optional(),
    stale: z.boolean(),
    previewAvailable: z.boolean(),
    expiresAt: positiveTimestamp,
    scope: featureResourceScopeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope.workspaceFolderId !== value.workspaceFolderId) {
      context.addIssue({
        code: 'custom',
        path: ['scope', 'workspaceFolderId'],
        message: 'Resource scope must use the same workspace folder as the context item.',
      })
    }
  })

const changeLocationSchema = z
  .object({
    relativePath: featureRelativePathSchema,
    line: z.number().int().nonnegative().max(1_000_000).optional(),
  })
  .strict()

export const changeSummarySchema = z
  .object({
    changeId: id,
    sessionId: id,
    workspaceFolderId: id,
    relativePath: featureRelativePathSchema,
    previousRelativePath: featureRelativePathSchema.optional(),
    status: z.enum(['added', 'modified', 'deleted', 'renamed', 'unknown']),
    additions: z.number().int().nonnegative().max(10_000_000).optional(),
    deletions: z.number().int().nonnegative().max(10_000_000).optional(),
    evidence: z.enum([
      'structured-proposal',
      'structured-tool-success',
      'filesystem-observed',
      'structured-location-only',
      'failed',
      'incomplete',
    ]),
    applicationState: z.enum(['proposed', 'applied-observed', 'failed', 'unknown']),
    reviewState: z.enum(['unreviewed', 'viewed', 'accepted', 'rejected', 'needs-attention']),
    sourceIds: z.array(id).max(16),
    locations: z.array(changeLocationSchema).max(32),
    firstSeenAt: positiveTimestamp,
    lastSeenAt: positiveTimestamp,
    identity: featureEventIdentitySchema,
    diffAvailable: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'renamed' && value.previousRelativePath === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['previousRelativePath'],
        message: 'Renamed changes must include their previous relative path.',
      })
    }
  })

export const taskSummarySchema = z
  .object({
    taskId: id,
    sourceId: id,
    sessionId: id.optional(),
    parentTaskId: id.optional(),
    workspaceFolderId: id,
    kind: z.enum(['session', 'subagent', 'job', 'goal', 'interaction', 'unknown']),
    title: safeLabel,
    status: z.enum([
      'running',
      'idle',
      'needs-input',
      'blocked',
      'failed',
      'completed',
      'cancelled',
      'disconnected',
      'unknown',
    ]),
    needsUserAction: z.boolean(),
    actionKind: z.enum(['approval', 'question', 'configuration', 'none']).optional(),
    interactionId: id.optional(),
    modelLabel: z.string().max(256).optional(),
    providerLabel: z.string().max(256).optional(),
    startedAt: timestamp,
    updatedAt: timestamp,
    progress: z.number().min(0).max(1).optional(),
    childCount: z.number().int().nonnegative().max(10_000),
    canOpen: z.boolean(),
    canAnswer: z.boolean(),
    canSessionCancel: z.boolean(),
    canProcessStop: z.boolean(),
    ownerKind: z.enum(['extension', 'external', 'unknown']),
    backendInstanceId: id.optional(),
    connectionGeneration: generation.optional(),
    taskRevision: generation,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.canProcessStop && value.ownerKind !== 'extension') {
      context.addIssue({
        code: 'custom',
        path: ['canProcessStop'],
        message: 'Only extension-owned tasks may expose process-stop.',
      })
    }
  })

export const checkpointSummarySchema = z
  .object({
    checkpointId: id,
    sessionId: id,
    workspaceFolderId: id,
    createdAt: timestamp,
    label: safeLabel.optional(),
    fileCount: z.number().int().nonnegative().max(100_000),
    totalBytes: z
      .number()
      .int()
      .nonnegative()
      .max(2 * 1024 * 1024 * 1024),
    state: z.enum(['metadata-only', 'content-ready', 'stale', 'corrupt', 'partial-restore', 'deleted']),
    restoreAllowed: z.boolean(),
    contentEnabled: z.boolean(),
    expectedRevision: generation.optional(),
  })
  .strict()

export const checkpointFilePreviewSchema = z
  .object({
    relativePath: featureRelativePathSchema,
    presentAtCheckpoint: z.boolean(),
    expectedCurrentHash: z.string().max(256).optional(),
    currentHash: z.string().max(256).optional(),
    conflict: z.boolean(),
    byteSize: z
      .number()
      .int()
      .nonnegative()
      .max(2 * 1024 * 1024 * 1024),
  })
  .strict()

export const checkpointPreviewSchema = z
  .object({
    summary: checkpointSummarySchema,
    files: z.array(checkpointFilePreviewSchema).max(100),
    conflictCount: z.number().int().nonnegative().max(100),
  })
  .strict()

export const promptTemplateSummarySchema = z
  .object({
    templateId: id,
    title: safeLabel,
    description: z.string().max(2_000),
    scope: z.enum(['workspace', 'global', 'session']),
    updatedAt: timestamp,
    variables: z
      .array(
        z.enum([
          'selection',
          'currentFile',
          'currentDiagnostics',
          'currentSymbol',
          'workspaceName',
          'sessionTitle',
        ]),
      )
      .max(64),
    enabled: z.boolean(),
  })
  .strict()

const featureRequestBase = { requestId: id }
const contextKind = z.enum(['selection', 'open-document', 'diagnostic', 'symbol'])
const featureTemplateVariables = z
  .record(z.string().min(1).max(128), z.string().max(10_000))
  .superRefine((value, context) => {
    const entries = Object.entries(value)
    if (entries.length > 64) {
      context.addIssue({ code: 'custom', message: 'A template may contain at most 64 variables.' })
    }
    const totalCharacters = entries.reduce((total, [key, entry]) => total + key.length + entry.length, 0)
    if (totalCharacters > 256_000) {
      context.addIssue({ code: 'custom', message: 'Template variables exceed the total size limit.' })
    }
  })

const promptTemplateVariable = z.enum([
  'selection',
  'currentFile',
  'currentDiagnostics',
  'currentSymbol',
  'workspaceName',
  'sessionTitle',
])
const promptTemplateOwnerPayload = {
  sessionId: id,
  workspaceFolderId: id,
}

/** Future request union. Do not merge it into `webviewRequestSchema` early. */
export const featureRequestSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('editor.context.capture'),
      ...featureRequestBase,
      payload: z.object({ kind: contextKind, workspaceFolderId: id.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('editor.context.list'),
      ...featureRequestBase,
      payload: z.object({ workspaceFolderId: id.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('editor.context.preview'),
      ...featureRequestBase,
      payload: z.object({ contextRef: id, workspaceFolderId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('editor.context.release'),
      ...featureRequestBase,
      payload: z
        .object({ contextRefs: z.array(id).min(1).max(MAX_CONTEXT_ITEMS), workspaceFolderId: id })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('feature.request.cancel'),
      ...featureRequestBase,
      payload: z.object({ targetRequestId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('changes.list'),
      ...featureRequestBase,
      payload: z
        .object({
          workspaceFolderId: id.optional(),
          sessionId: id.optional(),
          status: changeSummarySchema.shape.status.optional(),
          cursor: z.string().max(2_048).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('changes.detail'),
      ...featureRequestBase,
      payload: z.object({ changeId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('changes.markReviewed'),
      ...featureRequestBase,
      payload: z
        .object({
          changeId: id,
          reviewState: z.enum(['viewed', 'accepted', 'rejected', 'needs-attention']),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('changes.restore.prepare'),
      ...featureRequestBase,
      payload: z
        .object({
          changeId: id,
          expectedCurrentHash: z.string().min(1).max(256),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('checkpoint.create'),
      ...featureRequestBase,
      payload: z
        .object({ sessionId: id, workspaceFolderId: id, label: z.string().max(256).optional() })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('checkpoint.list'),
      ...featureRequestBase,
      payload: z.object({ sessionId: id.optional(), workspaceFolderId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('checkpoint.preview'),
      ...featureRequestBase,
      payload: z.object({ checkpointId: id, sessionId: id, workspaceFolderId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('checkpoint.delete'),
      ...featureRequestBase,
      payload: z.object({ checkpointId: id, sessionId: id, workspaceFolderId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('checkpoint.restore'),
      ...featureRequestBase,
      payload: z
        .object({
          checkpointId: id,
          sessionId: id,
          workspaceFolderId: id,
          expectedCurrentRevision: generation,
          conflictPolicy: z.enum(['abort', 'allow-partial']),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tasks.list'),
      ...featureRequestBase,
      payload: z
        .object({
          workspaceFolderId: id.optional(),
          sessionId: id.optional(),
          includeCompleted: z.boolean().optional(),
          cursor: z.string().max(2_048).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tasks.open'),
      ...featureRequestBase,
      payload: z.object({ taskId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tasks.stop'),
      ...featureRequestBase,
      payload: z
        .object({
          taskId: id,
          mode: z.enum(['session-cancel', 'process-stop']),
          taskRevision: generation,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tasks.answer'),
      ...featureRequestBase,
      payload: z.object({ taskId: id, interactionId: id, answer: z.string().max(100_000) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('prompt.template.list'),
      ...featureRequestBase,
      payload: z
        .object({
          ...promptTemplateOwnerPayload,
          scope: z.enum(['workspace', 'global', 'session']).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('prompt.template.read'),
      ...featureRequestBase,
      payload: z.object({ ...promptTemplateOwnerPayload, templateId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('prompt.template.insert'),
      ...featureRequestBase,
      payload: z
        .object({
          ...promptTemplateOwnerPayload,
          templateId: id,
          variables: featureTemplateVariables.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('prompt.template.create'),
      ...featureRequestBase,
      payload: z
        .object({
          ...promptTemplateOwnerPayload,
          title: safeLabel,
          description: z.string().max(2_000),
          /** User-authored text, never a raw upstream response/body. */
          templateText: z.string().min(1).max(100_000),
          scope: z.enum(['workspace', 'global', 'session']),
          variables: z.array(promptTemplateVariable).max(64),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('prompt.template.update'),
      ...featureRequestBase,
      payload: z
        .object({
          ...promptTemplateOwnerPayload,
          templateId: id,
          title: safeLabel.optional(),
          description: z.string().max(2_000).optional(),
          /** User-authored text, never a raw upstream response/body. */
          templateText: z.string().min(1).max(100_000).optional(),
          variables: z.array(promptTemplateVariable).max(64).optional(),
        })
        .refine(
          (value) =>
            value.title !== undefined ||
            value.description !== undefined ||
            value.templateText !== undefined ||
            value.variables !== undefined,
          'At least one template field must be updated.',
        )
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('prompt.template.delete'),
      ...featureRequestBase,
      payload: z.object({ ...promptTemplateOwnerPayload, templateId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('navigation.open'),
      ...featureRequestBase,
      payload: z
        .object({
          workspaceFolderId: id,
          relativePath: featureRelativePathSchema,
          range: featureRangeSchema.optional(),
          reveal: z.enum(['preserve-focus', 'focus']),
        })
        .strict(),
    })
    .strict(),
])

export const featureWebviewEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(1),
    message: featureRequestSchema,
  })
  .strict()

const featureResponsePayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('empty') }).strict(),
  z
    .object({
      kind: z.literal('editor.context'),
      items: z
        .array(editorContextItemSchema)
        .max(MAX_CONTEXT_ITEMS)
        .superRefine((items, context) => {
          const totalBytes = items.reduce((total, item) => total + item.sizeBytes, 0)
          if (totalBytes > MAX_CONTEXT_TOTAL_BYTES) {
            context.addIssue({ code: 'custom', message: 'Editor context exceeds the total size limit.' })
          }
        }),
      // Optional keeps the response readable by older hosts; the Webview
      // treats an omitted capability list as empty and never invents actions.
      availableKinds: contextKind.array().max(4).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('editor.preview'),
      contextRef: id,
      // The Host must redact this text before constructing the DTO. A raw
      // DSH response or filesystem object is never a valid feature payload.
      redactedPreviewText: boundedText.max(32_768),
      language: z.string().max(128),
      truncated: z.boolean(),
      expiresAt: positiveTimestamp,
    })
    .strict(),
  z
    .object({
      kind: z.literal('changes'),
      items: z.array(changeSummarySchema).max(200),
      nextCursor: z.string().max(2_048).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('change.detail'),
      change: changeSummarySchema,
      redactedDiff: boundedText.max(262_144).optional(),
      truncated: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('tasks'), items: z.array(taskSummarySchema).max(200) }).strict(),
  z
    .object({
      kind: z.literal('checkpoints'),
      items: z.array(checkpointSummarySchema).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal('checkpoint.preview'),
      preview: checkpointPreviewSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('prompt.templates'),
      items: z.array(promptTemplateSummarySchema).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal('prompt.template'),
      template: z
        .object({
          summary: promptTemplateSummarySchema,
          templateText: boundedText.max(100_000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('prompt.template.inserted'),
      templateId: id,
      text: boundedText.max(100_000),
      unresolvedVariables: z.array(promptTemplateVariable).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal('operation'),
      operationId: id,
      state: z.enum(['accepted', 'rejected', 'pending', 'completed', 'failed', 'partial']),
      message: z.string().max(2_000).optional(),
    })
    .strict(),
])

export const protocolAppErrorCodeSchema = z.enum([
  'DSH_NOT_FOUND',
  'DSH_INCOMPATIBLE',
  'BACKEND_UNREACHABLE',
  'BACKEND_BUSY',
  'NO_RUNNING_INSTANCE',
  'PORT_CONFLICT',
  'INVALID_ENDPOINT',
  'CAPABILITY_UNAVAILABLE',
  'AUTH_REQUIRED',
  'PERMISSION_DENIED',
  'STALE_INTERACTION',
  'PROCESS_FAILED',
  'EXPORT_FAILED',
  'PROTOCOL_ERROR',
  'REQUEST_CANCELLED',
  'INVALID_CONFIGURATION',
  'FEATURE_DISABLED',
  'CONTEXT_LIMIT',
  'CONTEXT_EXPIRED',
  'CONTEXT_STALE',
  'PATH_NOT_ALLOWED',
  'CHANGE_INCOMPLETE',
  'CHANGE_PROPOSAL_ONLY',
  'CHECKPOINT_CONFLICT',
  'CHECKPOINT_PARTIAL',
  'CHECKPOINT_QUOTA',
  'TASK_NOT_OWNED',
  'TASK_STATE_STALE',
  'STORAGE_CORRUPT',
  'RESOURCE_NOT_OWNED',
  'GENERATION_MISMATCH',
  'EVENT_GAP',
  'INTERNAL_ERROR',
])

const featureErrorSchema = z
  .object({
    code: protocolAppErrorCodeSchema,
    message: z.string().min(1).max(1_024),
    retryable: z.boolean(),
  })
  .strict()

export const featureResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      type: z.literal('feature.response'),
      requestId: id,
      ok: z.literal(true),
      payload: featureResponsePayloadSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('feature.response'),
      requestId: id,
      ok: z.literal(false),
      error: featureErrorSchema,
    })
    .strict(),
])

export const featureHostEventSchema = z.discriminatedUnion('name', [
  z
    .object({
      type: z.literal('feature.event'),
      name: z.literal('editor.context.changed'),
      identity: featureEventIdentitySchema,
      contextRef: id,
      action: z.enum(['added', 'updated', 'released']),
    })
    .strict(),
  z
    .object({
      type: z.literal('feature.event'),
      name: z.literal('editor.context.availability.changed'),
      identity: featureEventIdentitySchema,
      availableKinds: contextKind.array().max(4),
    })
    .strict(),
  z
    .object({
      type: z.literal('feature.event'),
      name: z.literal('changes.updated'),
      identity: featureEventIdentitySchema,
      change: changeSummarySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('feature.event'),
      name: z.literal('tasks.updated'),
      identity: featureEventIdentitySchema,
      task: taskSummarySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('feature.event'),
      name: z.literal('checkpoint.updated'),
      identity: featureEventIdentitySchema,
      checkpoint: checkpointSummarySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('feature.event'),
      name: z.literal('notification.safe'),
      identity: featureEventIdentitySchema,
      notificationId: id,
      level: z.enum(['info', 'warning', 'error']),
      message: z.string().min(1).max(2_000),
    })
    .strict(),
])

export const featureHostMessageSchema = z.union([featureResponseSchema, featureHostEventSchema])

export const featureHostEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(1),
    message: featureHostMessageSchema,
  })
  .strict()
