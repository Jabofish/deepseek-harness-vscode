import { z } from 'zod'
import {
  changeSummarySchema,
  featureRangeSchema,
  featureRelativePathSchema,
  generation,
  id,
  MAX_CONTEXT_ITEMS,
  safeLabel,
} from './feature-shared.js'
import { pluginRegistrySchema } from './feature-plugin.js'
import {
  scheduleAtInputSchema,
  schedulePrompt,
  scheduleRecordSchema,
  scheduleTime,
  scheduleTitle,
} from './feature-schedule.js'

export const featureRequestBase = { requestId: id }
export const contextKind = z.enum(['selection', 'open-document', 'diagnostic', 'symbol'])
export const featureTemplateVariables = z
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

export const promptTemplateVariable = z.enum([
  'selection',
  'currentFile',
  'currentDiagnostics',
  'currentSymbol',
  'workspaceName',
  'sessionTitle',
])
export const promptTemplateOwnerPayload = {
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
          previewId: id,
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
      type: z.literal('user-question.wait.attach'),
      ...featureRequestBase,
      payload: z.object({ sessionId: id, callId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('user-question.wait.release'),
      ...featureRequestBase,
      payload: z.object({ sessionId: id, callId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('user-question.answer'),
      ...featureRequestBase,
      payload: z
        .object({
          sessionId: id,
          callId: id,
          answer: z
            .object({
              answers: z
                .array(
                  z
                    .object({
                      id,
                      selected: z.array(z.string().max(100_000)).max(64),
                      custom: z.string().max(100_000).optional(),
                    })
                    .strict(),
                )
                .min(1)
                .max(64)
                .superRefine((answers, context) => {
                  if (new Set(answers.map((item) => item.id)).size !== answers.length)
                    context.addIssue({ code: 'custom', message: 'Question answer ids cannot repeat.' })
                }),
            })
            .strict(),
        })
        .strict(),
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
      type: z.literal('plugin.bundle.waitForInstall'),
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
