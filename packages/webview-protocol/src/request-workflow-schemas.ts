import { z } from 'zod'
import { id, requestBase, MAX_PROMPT_ATTACHMENTS, session, attachmentSchema } from './request-common.js'

export const workflowRequestSchemas = [
  z.object({ type: z.literal('goal.list'), ...requestBase, payload: z.object(session).strict() }).strict(),
  z
    .object({
      type: z.literal('goal.update'),
      ...requestBase,
      payload: z
        .object({
          goalId: id,
          title: z.string().min(1).max(1024).optional(),
          status: z.enum(['pending', 'in-progress', 'completed', 'blocked']).optional(),
          maxGoalRounds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('goal.clear'), ...requestBase, payload: z.object({ goalId: id }).strict() })
    .strict(),
  z.object({ type: z.literal('job.list'), ...requestBase, payload: z.object(session).strict() }).strict(),
  z
    .object({
      type: z.literal('job.kill'),
      ...requestBase,
      payload: z.object({ sessionId: id, jobId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('job.follow.start'),
      ...requestBase,
      payload: z
        .object({
          sessionId: id,
          jobId: id,
          followId: id,
          from: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('job.follow.stop'),
      ...requestBase,
      payload: z.object({ sessionId: id, jobId: id, followId: id }).strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('subagent.list'), ...requestBase, payload: z.object(session).strict() })
    .strict(),
  z
    .object({
      type: z.literal('subagent.history'),
      ...requestBase,
      payload: z
        .object({
          sessionId: id,
          beforeSeq: z.number().int().nonnegative().optional(),
          maxMessages: z.number().int().positive().max(200).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('subagent.send'),
      ...requestBase,
      payload: z
        .object({
          sessionId: id,
          message: z.string().min(1).max(1_000_000),
          // Kept optional at the protocol boundary for older Webviews; the
          // parsed output always supplies the DSH delivery default.
          mode: z.enum(['queue', 'steer']).optional().default('queue'),
          attachments: z.array(attachmentSchema).max(MAX_PROMPT_ATTACHMENTS).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('subagent.interrupt'), ...requestBase, payload: z.object(session).strict() })
    .strict(),
  z
    .object({
      type: z.literal('skill.list'),
      ...requestBase,
      payload: z.object({ sessionId: id.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('skill.openDocument'),
      ...requestBase,
      payload: z.object({ ...session, skillId: id }).strict(),
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
      payload: z
        .object({
          sessionId: id,
          command: z.string().min(1).max(100_000),
          attachments: z.array(attachmentSchema).max(MAX_PROMPT_ATTACHMENTS).optional(),
        })
        .strict(),
    })
    .strict(),
] as const
