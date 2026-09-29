import { z } from 'zod'
import {
  accountLifecycleSnapshotSchema,
  accountProfileDetailsSnapshotSchema,
  accountSignOutImpactSchema,
} from '../account-lifecycle-schemas.js'
import {
  boundedText,
  changeSummarySchema,
  editorContextItemSchema,
  id,
  MAX_CONTEXT_ITEMS,
  MAX_CONTEXT_TOTAL_BYTES,
  positiveTimestamp,
  taskSummarySchema,
} from './feature-shared.js'
import {
  managedPluginBundleSchema,
  managedPluginEntrySchema,
  pluginBundleChangeResultSchema,
  pluginInspectionSchema,
  pluginRegistriesSchema,
} from './feature-plugin.js'
import {
  scheduleCatalogEntrySchema,
  scheduleDeletePayloadSchema,
  scheduleHistoryPayloadSchema,
  scheduleRecordSchema,
  scheduleUpdatePayloadSchema,
} from './feature-schedule.js'
import {
  checkpointPreviewSchema,
  checkpointSummarySchema,
  promptTemplateSummarySchema,
} from './feature-checkpoints.js'
import { contextKind, promptTemplateVariable } from './feature-requests.js'

export const featureResponsePayloadSchema = z.discriminatedUnion('kind', [
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
  z
    .object({
      kind: z.literal('question.wait'),
      remainingMs: z.number().int().min(0).max(2_147_483_647).nullable(),
    })
    .strict(),
  z.object({ kind: z.literal('question.answer'), accepted: z.boolean() }).strict(),
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
  z
    .object({
      kind: z.literal('plugin.install.waited'),
      result: pluginBundleChangeResultSchema.nullable(),
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
  'SETTINGS_CONFLICT',
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
  'PLUGIN_INSTALL_NOT_STARTED',
  'INTERNAL_ERROR',
])

export const featureErrorSchema = z
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
