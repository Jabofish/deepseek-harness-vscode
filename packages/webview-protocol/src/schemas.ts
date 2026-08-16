import { z } from 'zod'

const id = z.string().min(1).max(256)
const requestBase = { requestId: id }
const session = { sessionId: id }
const attachmentSchema = z
  .object({
    uri: z.string().min(1).max(8192),
    name: z.string().min(1).max(512),
    mimeType: z.string().max(256).optional(),
  })
  .strict()
const promptSchema = z
  .object({
    sessionId: id,
    text: z.string().max(1_000_000),
    attachments: z.array(attachmentSchema).max(32),
  })
  .strict()
const agentConfigurationSchema = z
  .object({
    preset: z.enum(['standard', 'code', 'minimal', 'cordis']),
    toolMode: z.enum(['native', 'code', 'both']),
    permissionPreset: z.enum(['read-only', 'workspace-write', 'full-access']),
    planMode: z.boolean(),
    model: z
      .object({
        providerId: id,
        modelId: id,
        reasoningLevel: z.string().max(128).optional(),
      })
      .strict(),
  })
  .strict()

export const webviewRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('app.ready'), ...requestBase }).strict(),
  z.object({ type: z.literal('connection.retry'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('runtime.action'),
      ...requestBase,
      payload: z.object({ action: z.enum(['install', 'select', 'copy-command', 'open-docs']) }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('workspace.list'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('workspace.create'),
      ...requestBase,
      payload: z.object({ name: z.string().min(1).max(256), uri: z.string().min(1).max(8192) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('workspace.rename'),
      ...requestBase,
      payload: z.object({ workspaceId: id, name: z.string().min(1).max(256) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('workspace.remove'),
      ...requestBase,
      payload: z.object({ workspaceId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.list'),
      ...requestBase,
      payload: z
        .object({
          workspaceId: id.optional(),
          search: z.string().max(512).optional(),
          archived: z.boolean().optional(),
          cursor: z.string().max(2048).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal('session.open'), ...requestBase, payload: z.object(session).strict() }).strict(),
  z
    .object({
      type: z.literal('session.create'),
      ...requestBase,
      payload: z
        .object({
          workspaceId: id,
          title: z.string().max(512).optional(),
          configuration: agentConfigurationSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.rename'),
      ...requestBase,
      payload: z.object({ sessionId: id, title: z.string().min(1).max(512) }).strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('session.remove'), ...requestBase, payload: z.object(session).strict() })
    .strict(),
  z.object({ type: z.literal('session.fork'), ...requestBase, payload: z.object(session).strict() }).strict(),
  z
    .object({
      type: z.literal('session.archive'),
      ...requestBase,
      payload: z.object({ sessionId: id, archived: z.boolean() }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('session.sendPrompt'), ...requestBase, payload: promptSchema }).strict(),
  z
    .object({
      type: z.literal('session.enqueuePrompt'),
      ...requestBase,
      payload: promptSchema.extend({ mode: z.enum(['queue', 'steer']) }).strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('session.queue.list'), ...requestBase, payload: z.object(session).strict() })
    .strict(),
  z
    .object({
      type: z.literal('session.queue.update'),
      ...requestBase,
      payload: z.object({ inputId: id, text: z.string().max(1_000_000) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.queue.remove'),
      ...requestBase,
      payload: z.object({ inputId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.queue.steer'),
      ...requestBase,
      payload: z.object({ inputId: id }).strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('session.cancel'), ...requestBase, payload: z.object(session).strict() })
    .strict(),
  z
    .object({
      type: z.literal('session.configure'),
      ...requestBase,
      payload: z.object({ sessionId: id, configuration: agentConfigurationSchema }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('attachment.pick'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('models.list'),
      ...requestBase,
      payload: z.object({ providerId: id.optional() }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('providers.list'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('provider.secret.configure'),
      ...requestBase,
      payload: z.object({ providerId: id, field: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('provider.secret.remove'),
      ...requestBase,
      payload: z.object({ providerId: id, field: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('interaction.permission.respond'),
      ...requestBase,
      payload: z.object({ interactionId: id, optionId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('interaction.question.respond'),
      ...requestBase,
      payload: z
        .object({ questionId: id, response: z.union([z.string().max(100_000), z.array(id).max(32)]) })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal('settings.read'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('settings.update'),
      ...requestBase,
      payload: z.object({ path: z.string().min(1).max(512), value: z.unknown() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('settings.replace'),
      ...requestBase,
      payload: z.object({ values: z.record(z.string(), z.unknown()) }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('goal.list'), ...requestBase, payload: z.object(session).strict() }).strict(),
  z
    .object({
      type: z.literal('goal.create'),
      ...requestBase,
      payload: z.object({ sessionId: id, title: z.string().min(1).max(1024) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('goal.update'),
      ...requestBase,
      payload: z
        .object({ goalId: id, title: z.string().min(1).max(1024).optional(), status: id.optional() })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal('job.list'), ...requestBase, payload: z.object(session).strict() }).strict(),
  z
    .object({ type: z.literal('job.cancel'), ...requestBase, payload: z.object({ jobId: id }).strict() })
    .strict(),
  z
    .object({ type: z.literal('subagent.list'), ...requestBase, payload: z.object(session).strict() })
    .strict(),
  z
    .object({
      type: z.literal('subagent.send'),
      ...requestBase,
      payload: z.object({ sessionId: id, message: z.string().min(1).max(1_000_000) }).strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('subagent.interrupt'), ...requestBase, payload: z.object(session).strict() })
    .strict(),
  z
    .object({ type: z.literal('workflow.list'), ...requestBase, payload: z.object(session).strict() })
    .strict(),
  z
    .object({
      type: z.literal('workflow.start'),
      ...requestBase,
      payload: z.object({ sessionId: id, workflowId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('workflow.cancel'),
      ...requestBase,
      payload: z.object({ workflowId: id }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('skill.list'), ...requestBase }).strict(),
  z.object({ type: z.literal('skill.refresh'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('skill.execute'),
      ...requestBase,
      payload: z.object({ sessionId: id, skillId: id, input: z.string().max(1_000_000) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('command.list'),
      ...requestBase,
      payload: z.object({ sessionId: id.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('command.execute'),
      ...requestBase,
      payload: z.object({ sessionId: id, command: z.string().min(1).max(100_000) }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('plugin.list'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('plugin.configure'),
      ...requestBase,
      payload: z.object({ pluginId: id, enabled: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.export'),
      ...requestBase,
      payload: z
        .object({
          sessionId: id,
          format: z.enum(['markdown', 'json', 'zip']),
          includeAttachments: z.boolean(),
          includeReasoning: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal('diagnostics.show'), ...requestBase }).strict(),
  z.object({ type: z.literal('view.moveRightGuide'), ...requestBase }).strict(),
])

export const hostResponseSchema = z
  .object({
    type: z.literal('response'),
    requestId: id,
    ok: z.boolean(),
    payload: z.unknown().optional(),
    error: z
      .object({
        code: z.string().min(1).max(128),
        message: z.string().min(1).max(4096),
        retryable: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const hostEventSchema = z
  .object({
    type: z.literal('event'),
    name: z.string().min(1).max(256),
    sequence: z.number().int().nonnegative(),
    payload: z.unknown(),
  })
  .strict()

export const hostMessageSchema = z.union([hostResponseSchema, hostEventSchema])
