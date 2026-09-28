import { z } from 'zod'
import { id, requestBase, session, promptSchema, agentConfigurationSchema } from './request-common.js'

export const sessionRequestSchemas = [
  z.object({ type: z.literal('workspace.list'), ...requestBase }).strict(),
  z.object({ type: z.literal('workspace.addFolder'), ...requestBase }).strict(),
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
      type: z.literal('workspace.move'),
      ...requestBase,
      payload: z.object({ workspaceId: id, beforeWorkspaceId: id.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.move'),
      ...requestBase,
      payload: z.object({ workspaceId: id, sessionId: id, beforeSessionId: id.optional() }).strict(),
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
      type: z.literal('session.history'),
      ...requestBase,
      payload: z
        .object({
          sessionId: id,
          beforeSeq: z.number().int().nonnegative().optional(),
          maxMessages: z.number().int().positive().max(200).optional(),
          pagePurpose: z.enum(['transcript', 'gap-recovery']).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.create'),
      ...requestBase,
      payload: z
        .object({
          workspaceId: id.optional(),
          sessionId: id.optional(),
          reuseWorkspaceBlank: z.literal(true).optional(),
          title: z.string().max(512).optional(),
          configuration: agentConfigurationSchema,
        })
        .strict()
        .refine(
          (payload) =>
            payload.reuseWorkspaceBlank !== true ||
            (payload.workspaceId !== undefined && payload.sessionId !== undefined),
          { message: 'Reusing a workspace blank session requires workspaceId and sessionId.' },
        ),
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
  z
    .object({
      type: z.literal('session.fork'),
      ...requestBase,
      payload: z.object({ sessionId: id, atSeq: z.number().int().nonnegative().optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.archive'),
      ...requestBase,
      payload: z.object({ sessionId: id, archived: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.sendPrompt'),
      ...requestBase,
      payload: promptSchema.extend({ mode: z.enum(['queue', 'steer']).default('queue') }),
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
] as const
