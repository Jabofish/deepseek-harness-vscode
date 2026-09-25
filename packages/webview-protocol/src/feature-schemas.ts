import { z } from 'zod'
import {
  accountLifecycleErrorCodeSchema,
  accountProfileDetailsSnapshotSchema,
  accountLifecycleSnapshotSchema,
  accountSignOutImpactSchema,
} from './account-lifecycle-schemas.js'

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
    sessionTitle: safeLabel.optional(),
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
    ownerKind: z.enum(['extension', 'external', 'unknown']),
    backendInstanceId: id.optional(),
    connectionGeneration: generation.optional(),
    taskRevision: generation,
  })
  .strict()

const scheduleTimestamp = z.string().datetime({ offset: false })
const pluginBundleTextSchema = z.union([
  z.string().max(4_096),
  z
    .object({ en: z.string().max(4_096) })
    .catchall(z.string().max(4_096))
    .superRefine((value, context) => {
      const entries = Object.entries(value)
      if (entries.length > 16 || !entries.every(([locale]) => /^[A-Za-z0-9-]{1,32}$/u.test(locale)))
        context.addIssue({ code: 'custom', message: 'Localized bundle text has invalid locale keys.' })
    }),
])
const pluginMetadataSchema = z
  .object({
    title: pluginBundleTextSchema.optional(),
    description: pluginBundleTextSchema.optional(),
  })
  .strict()
const pluginRegistryUrlSchema = z
  .string()
  .max(2_048)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === ''
      )
    } catch {
      return false
    }
  }, 'Registry URLs cannot contain credentials or query data.')
const pluginRegistrySchema = z.union([z.literal(null), pluginRegistryUrlSchema])
const pluginBundleErrorCodeSchema = z.enum([
  'management-required',
  'unaddressable',
  'unknown-plugin',
  'invalid-spec',
  'ambiguous-install',
  'not-bundle',
  'not-removable',
  'stop-profile',
  'bundle-in-use',
  'stale-approval',
  'incompatible-version',
  'operation-error',
])
const managedPluginEntrySchema = z
  .object({
    entryId: safeLabel,
    moduleName: safeLabel,
    meta: pluginMetadataSchema.optional(),
    enabled: z.boolean(),
    fiberPhase: z.enum(['pending', 'loading', 'active', 'failed', 'unloading']).nullable(),
    readOnlyReason: z.enum(['management-required', 'unaddressable']).optional(),
  })
  .strict()
const pluginBundleRowSchema = z
  .object({
    rowId: safeLabel,
    moduleName: safeLabel,
    meta: pluginMetadataSchema.optional(),
    entryId: safeLabel.optional(),
  })
  .strict()
const managedPluginBundleSchema = z
  .object({
    name: safeLabel,
    version: z.string().max(128).optional(),
    title: pluginBundleTextSchema.optional(),
    description: pluginBundleTextSchema.optional(),
    enabled: z.boolean(),
    installed: z.boolean(),
    optional: z.boolean(),
    removable: z.boolean(),
    readOnlyReason: z.enum(['management-required', 'unaddressable']).optional(),
    errorCode: pluginBundleErrorCodeSchema.optional(),
    rows: z.array(pluginBundleRowSchema).max(2_000),
    overrides: z.array(safeLabel).max(2_000),
  })
  .strict()
const pluginBundleChangeResultSchema = z
  .object({
    name: safeLabel,
    changed: z.boolean(),
    application: z.enum(['applied', 'restart-required', 'overridden', 'failed', 'cancelled']),
    enabled: z.boolean().optional(),
    stage: z.enum(['install', 'enable', 'remove']).optional(),
    errorCode: pluginBundleErrorCodeSchema.optional(),
    failureKind: z
      .enum([
        'pnpm-missing',
        'timeout',
        'not-found',
        'no-matching-version',
        'network',
        'disk-full',
        'permission',
        'build-blocked',
        'integrity',
        'unknown',
      ])
      .optional(),
    failedAt: z.enum(['registry', 'spec-host']).optional(),
    bundle: safeLabel.optional(),
    pendingBuilds: z.array(safeLabel).max(256).optional(),
  })
  .strict()
const pluginInspectionSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('accepted'),
      kind: z.enum(['registry', 'path', 'git', 'tarball']),
      name: safeLabel.optional(),
      version: z.string().max(128).optional(),
      description: z.string().max(4_096).optional(),
      bundle: z.boolean().nullable(),
      registry: pluginRegistrySchema,
      host: z.string().max(255).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('refused'),
      problem: z.enum([
        'invalid-spec',
        'already-installed',
        'not-found',
        'not-a-package',
        'not-a-bundle',
        'network',
        'unknown',
      ]),
      registries: z.array(pluginRegistrySchema).max(64).optional(),
    })
    .strict(),
])
const pluginRegistriesSchema = z
  .object({
    registry: pluginRegistrySchema,
    fallbackRegistries: z.array(pluginRegistryUrlSchema).max(64),
    resolved: pluginRegistrySchema,
  })
  .strict()
const schedulePrompt = z.string().min(1).max(16_000_000)
const scheduleTitle = z.string().min(1).max(120)
const scheduleDate = z.string().regex(/^\d{4}-\d\d-\d\d$/u)
const scheduleTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/u)
const scheduleAtInputSchema = z.union([
  z.string().datetime({ offset: true }),
  z.object({ date: scheduleDate, time: scheduleTime, timeZone: z.string().min(1).max(256) }).strict(),
])

/** Closed, Webview-safe projection of rc.2 Schedule rules. */
export const scheduleRecordSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id,
      kind: z.literal('at'),
      title: scheduleTitle,
      prompt: schedulePrompt,
      scheduledAt: scheduleTimestamp,
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal('after'),
      title: scheduleTitle,
      prompt: schedulePrompt,
      scheduledAt: scheduleTimestamp,
      afterSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal('every'),
      title: scheduleTitle,
      prompt: schedulePrompt,
      scheduledAt: scheduleTimestamp,
      everySeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal('daily'),
      title: scheduleTitle,
      prompt: schedulePrompt,
      scheduledAt: scheduleTimestamp,
      time: scheduleTime,
      timeZone: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal('weekly'),
      title: scheduleTitle,
      prompt: schedulePrompt,
      scheduledAt: scheduleTimestamp,
      time: scheduleTime,
      timeZone: z.string().min(1).max(256),
      weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    })
    .strict()
    .superRefine((value, context) => {
      if (new Set(value.weekdays).size !== value.weekdays.length)
        context.addIssue({ code: 'custom', path: ['weekdays'], message: 'Weekdays cannot repeat.' })
    }),
  z
    .object({
      id,
      kind: z.literal('cron'),
      title: scheduleTitle,
      prompt: schedulePrompt,
      scheduledAt: scheduleTimestamp,
      expression: z.string().min(1).max(256),
      timeZone: z.string().min(1).max(256),
    })
    .strict(),
])

const scheduleDeliveryReceiptSchema = z
  .object({
    scheduledAt: scheduleTimestamp,
    deliveredAt: scheduleTimestamp,
    messageId: id,
  })
  .strict()

export const scheduleCatalogEntrySchema = z.intersection(
  scheduleRecordSchema,
  z
    .object({
      sessionId: id,
      status: z.enum(['active', 'inactive']),
      lastDelivery: scheduleDeliveryReceiptSchema.optional(),
    })
    .strict(),
)

const scheduleDeliveryRecordSchema = z
  .object({
    ...scheduleDeliveryReceiptSchema.shape,
    prompt: z.string().max(16_000_000).optional(),
  })
  .strict()

const scheduleHistoryPayloadSchema = z.union([
  z
    .object({
      id,
      records: z.array(scheduleDeliveryRecordSchema).max(100),
      earlierRecordsUnavailable: z.boolean(),
      earlierRecordsPruned: z.boolean(),
      retention: z
        .object({
          days: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          records: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
      nextBefore: id.optional(),
    })
    .strict(),
  z.object({ id, code: z.enum(['schedule_not_found', 'delivery_cursor_not_found']) }).strict(),
])

const scheduleToolFailureSchema = z
  .object({
    code: z.enum([
      'invalid_prompt',
      'invalid_selector',
      'invalid_rule',
      'invalid_time_zone',
      'not_future',
      'time_out_of_range',
      'frequency_too_high',
      'internal_error',
    ]),
    message: z.string().min(1).max(2_000),
  })
  .strict()

const scheduleUpdatePayloadSchema = z.union([
  z.object({ id, updated: z.boolean(), record: scheduleRecordSchema }).strict(),
  z
    .object({
      id,
      updated: z.literal(false),
      code: z.enum(['schedule_not_found', 'schedule_ended', 'schedule_conflict']),
    })
    .strict(),
  scheduleToolFailureSchema,
])

const scheduleDeletePayloadSchema = z.union([
  z.object({ id, deleted: z.literal(true) }).strict(),
  z.object({ id, deleted: z.literal(false), code: z.literal('schedule_not_found') }).strict(),
  scheduleToolFailureSchema,
])

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
          conflictPolicy: z.enum(['abort', 'overwrite']),
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
          scope: z.enum(['current-session', 'workspace']).optional(),
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
      type: z.literal('schedule.catalog'),
      ...featureRequestBase,
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('plugin.bundles.list'),
      ...featureRequestBase,
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('plugin.registries.list'),
      ...featureRequestBase,
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('plugin.spec.inspect'),
      ...featureRequestBase,
      payload: z
        .object({ spec: z.string().min(1).max(4_096), registry: pluginRegistrySchema.optional() })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('plugin.bundle.install'),
      ...featureRequestBase,
      payload: z
        .object({
          spec: z.string().min(1).max(4_096),
          installRequestId: id,
          registry: pluginRegistrySchema.optional(),
          approvedBuilds: z.array(safeLabel).max(256).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('plugin.bundle.cancelInstall'),
      ...featureRequestBase,
      payload: z.object({ installRequestId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('plugin.bundle.setEnabled'),
      ...featureRequestBase,
      payload: z.object({ name: safeLabel, enabled: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('plugin.bundle.remove'),
      ...featureRequestBase,
      payload: z.object({ name: safeLabel }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('plugin.entry.setEnabled'),
      ...featureRequestBase,
      payload: z.object({ entryId: safeLabel, enabled: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('account.state'), ...featureRequestBase, payload: z.object({}).strict() })
    .strict(),
  z
    .object({ type: z.literal('account.signIn'), ...featureRequestBase, payload: z.object({}).strict() })
    .strict(),
  z
    .object({
      type: z.literal('account.cancelSignIn'),
      ...featureRequestBase,
      payload: z.object({ attemptId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('account.signOutImpact'),
      ...featureRequestBase,
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('account.signOut'), ...featureRequestBase, payload: z.object({}).strict() })
    .strict(),
  z
    .object({
      type: z.literal('account.details.read'),
      ...featureRequestBase,
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('account.bonus.ack'),
      ...featureRequestBase,
      payload: z.object({ orderId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('account.page.open'),
      ...featureRequestBase,
      payload: z.object({ page: z.enum(['usage', 'top-up']) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('schedule.list'),
      ...featureRequestBase,
      payload: z.object({ sessionId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('schedule.history'),
      ...featureRequestBase,
      payload: z
        .object({ sessionId: id, id, limit: z.number().int().min(1).max(100), before: id.optional() })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('schedule.update'),
      ...featureRequestBase,
      payload: z
        .object({
          sessionId: id,
          id,
          expected: scheduleRecordSchema,
          change: z
            .discriminatedUnion('kind', [
              z.object({ kind: z.literal('at'), at: scheduleAtInputSchema }).strict(),
              z
                .object({
                  kind: z.literal('every'),
                  seconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
                })
                .strict(),
              z
                .object({
                  kind: z.literal('daily'),
                  time: scheduleTime,
                  timeZone: z.string().min(1).max(256),
                })
                .strict(),
              z
                .object({
                  kind: z.literal('weekly'),
                  time: scheduleTime,
                  timeZone: z.string().min(1).max(256),
                  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
                })
                .strict()
                .superRefine((value, context) => {
                  if (new Set(value.weekdays).size !== value.weekdays.length)
                    context.addIssue({
                      code: 'custom',
                      path: ['weekdays'],
                      message: 'Weekdays cannot repeat.',
                    })
                }),
              z
                .object({
                  kind: z.literal('cron'),
                  expression: z.string().min(1).max(256),
                  timeZone: z.string().min(1).max(256),
                })
                .strict(),
            ])
            .optional()
            .superRefine((change, context) => {
              if (change?.kind === 'weekly' && new Set(change.weekdays).size !== change.weekdays.length)
                context.addIssue({ code: 'custom', path: ['weekdays'], message: 'Weekdays cannot repeat.' })
            }),
          title: scheduleTitle.optional(),
          prompt: schedulePrompt.optional(),
        })
        .strict()
        .superRefine((value, context) => {
          if (value.change === undefined && value.title === undefined && value.prompt === undefined)
            context.addIssue({ code: 'custom', message: 'A Schedule update must change at least one field.' })
          if (value.id !== value.expected.id)
            context.addIssue({
              code: 'custom',
              path: ['expected', 'id'],
              message: 'Expected rule identity must match.',
            })
        }),
    })
    .strict(),
  z
    .object({
      type: z.literal('schedule.delete'),
      ...featureRequestBase,
      payload: z.object({ sessionId: id, id }).strict(),
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
  z.object({ kind: z.literal('account.lifecycle'), snapshot: accountLifecycleSnapshotSchema }).strict(),
  z.object({ kind: z.literal('account.impact'), impact: accountSignOutImpactSchema }).strict(),
  z.object({ kind: z.literal('account.details'), snapshot: accountProfileDetailsSnapshotSchema }).strict(),
  z.object({ kind: z.literal('account.bonus.ack'), accepted: z.boolean() }).strict(),
  z.object({ kind: z.literal('account.page.opened'), page: z.enum(['usage', 'top-up']) }).strict(),
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
      refreshFailed: z.boolean().optional(),
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
  z
    .object({
      kind: z.literal('tasks'),
      items: z.array(taskSummarySchema).max(200),
      scope: z.enum(['current-session', 'workspace']),
      source: z.enum(['current-session', 'workspace-composed']),
      complete: z.boolean(),
      omittedSessions: z.number().int().nonnegative().max(64),
    })
    .strict(),
  z
    .object({ kind: z.literal('schedule.catalog'), items: z.array(scheduleCatalogEntrySchema).max(10_000) })
    .strict(),
  z
    .object({ kind: z.literal('schedule.records'), items: z.array(scheduleRecordSchema).max(10_000) })
    .strict(),
  z.object({ kind: z.literal('schedule.history'), result: scheduleHistoryPayloadSchema }).strict(),
  z.object({ kind: z.literal('schedule.updated'), result: scheduleUpdatePayloadSchema }).strict(),
  z.object({ kind: z.literal('schedule.deleted'), result: scheduleDeletePayloadSchema }).strict(),
  z
    .object({
      kind: z.literal('plugin.bundles'),
      available: z.boolean(),
      bundles: z.array(managedPluginBundleSchema).max(5_000),
      plugins: z.array(managedPluginEntrySchema).max(10_000),
    })
    .strict()
    .superRefine((value, context) => {
      if (!value.available && (value.bundles.length !== 0 || value.plugins.length !== 0))
        context.addIssue({
          code: 'custom',
          path: ['bundles'],
          message: 'Unavailable Plugin Manager has no catalog.',
        })
    }),
  z
    .object({
      kind: z.literal('plugin.registries'),
      available: z.boolean(),
      registries: pluginRegistriesSchema.nullable(),
    })
    .strict()
    .superRefine((value, context) => {
      if (!value.available && value.registries !== null)
        context.addIssue({
          code: 'custom',
          path: ['registries'],
          message: 'Unavailable Plugin Manager has no registries.',
        })
    }),
  z.object({ kind: z.literal('plugin.inspection'), inspection: pluginInspectionSchema }).strict(),
  z
    .object({
      kind: z.literal('plugin.install.cancelled'),
      status: z.enum(['cancelled', 'too-late', 'not-running']),
    })
    .strict(),
  z.object({ kind: z.literal('plugin.bundle.changed'), result: pluginBundleChangeResultSchema }).strict(),
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
      name: z.literal('account.lifecycle.updated'),
      identity: featureEventIdentitySchema,
      snapshot: accountLifecycleSnapshotSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('feature.event'),
      name: z.literal('account.session-expired'),
      identity: featureEventIdentitySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('feature.event'),
      name: z.literal('account.lifecycle.error'),
      identity: featureEventIdentitySchema,
      code: accountLifecycleErrorCodeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('feature.event'),
      name: z.literal('changes.invalidated'),
      identity: featureEventIdentitySchema,
      sessionId: id,
    })
    .strict(),
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
      name: z.literal('schedule.invalidated'),
      identity: featureEventIdentitySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('feature.event'),
      name: z.literal('plugin.manager.changed'),
      identity: featureEventIdentitySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('feature.event'),
      name: z.literal('plugin.install.progress'),
      identity: featureEventIdentitySchema,
      requestId: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9._:-]+$/u),
      phase: z.enum(['installing', 'cancelling', 'applying']),
      attemptIndex: z.number().int().min(1).max(64).optional(),
      attemptTotal: z.number().int().min(1).max(64).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      const hasIndex = value.attemptIndex !== undefined
      const hasTotal = value.attemptTotal !== undefined
      if (hasIndex !== hasTotal || (hasIndex && value.phase !== 'installing'))
        context.addIssue({ code: 'custom', message: 'Install attempts only accompany an installing phase.' })
      if (hasIndex && value.attemptIndex! > value.attemptTotal!)
        context.addIssue({ code: 'custom', message: 'Install attempt index exceeds the attempt count.' })
    }),
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
