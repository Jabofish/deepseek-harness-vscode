import { z } from 'zod'
import { id } from './feature-shared.js'

export const scheduleTimestamp = z.string().datetime({ offset: false })
export const schedulePrompt = z.string().min(1).max(16_000_000)
export const scheduleTitle = z.string().min(1).max(120)
export const scheduleDate = z.string().regex(/^\d{4}-\d\d-\d\d$/u)
export const scheduleTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/u)
export const scheduleAtInputSchema = z.union([
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
  z
    .object({
      id,
      kind: z.literal('rrule'),
      title: scheduleTitle,
      prompt: schedulePrompt,
      scheduledAt: scheduleTimestamp,
      rrule: z.string().min(1).max(64_000),
    })
    .strict(),
])

export const scheduleDeliveryReceiptSchema = z
  .object({
    scheduledAt: scheduleTimestamp,
    deliveredAt: scheduleTimestamp,
    messageId: id,
    targetSessionId: id.optional(),
  })
  .strict()

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: id }).strict(),
  z.object({ kind: z.literal('new_once'), sessionId: id, agentPreset: id.optional() }).strict(),
  z.object({ kind: z.literal('new'), agentPreset: id.optional() }).strict(),
])
export const scheduleCatalogEntrySchema = z
  .union(
    scheduleRecordSchema.options.map((schema) =>
      schema.safeExtend({
        sessionId: id.optional(),
        status: z.enum(['active', 'inactive', 'paused', 'ended']),
        target: targetSchema.optional(),
        updatedAt: scheduleTimestamp.optional(),
        workspaceId: id.optional(),
        lastDelivery: scheduleDeliveryReceiptSchema.optional(),
      }),
    ),
  )
  .superRefine((entry, context) => {
    if (entry.target === undefined && entry.sessionId === undefined)
      context.addIssue({ code: 'custom', message: 'A Schedule target or legacy session is required.' })
    if (
      entry.target !== undefined &&
      entry.sessionId !== undefined &&
      (entry.target.kind !== 'session' || entry.target.sessionId !== entry.sessionId)
    )
      context.addIssue({ code: 'custom', message: 'Schedule session and target must agree.' })
  })

export const scheduleCreateTimingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('after'), seconds: z.number().int().positive().safe() }).strict(),
  z.object({ kind: z.literal('at'), at: scheduleAtInputSchema }).strict(),
  z.object({ kind: z.literal('every'), seconds: z.number().int().min(60).safe() }).strict(),
  z.object({ kind: z.literal('daily'), time: scheduleTime, timeZone: z.string().min(1).max(256) }).strict(),
  z
    .object({
      kind: z.literal('weekly'),
      time: scheduleTime,
      timeZone: z.string().min(1).max(256),
      weekdays: z
        .array(z.number().int().min(1).max(7))
        .min(1)
        .max(7)
        .refine((days) => new Set(days).size === days.length),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cron'),
      expression: z.string().min(1).max(256),
      timeZone: z.string().min(1).max(256),
    })
    .strict(),
  z.object({ kind: z.literal('rrule'), rrule: z.string().min(1).max(64_000) }).strict(),
])

export const scheduleDeliveryRecordSchema = z
  .object({
    ...scheduleDeliveryReceiptSchema.shape,
    prompt: z.string().max(16_000_000).optional(),
  })
  .strict()

export const scheduleHistoryPayloadSchema = z.union([
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

export const scheduleToolFailureSchema = z
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

export const scheduleUpdatePayloadSchema = z.union([
  z.object({ id, updated: z.boolean(), record: scheduleRecordSchema }).strict(),
  z
    .object({
      id,
      updated: z.literal(false),
      code: z.enum(['schedule_not_found', 'schedule_ended', 'schedule_conflict']),
    })
    .strict(),
  scheduleToolFailureSchema,
  z.object({ code: z.literal('subagent_session'), message: z.string().min(1).max(2_000) }).strict(),
])

export const scheduleDeletePayloadSchema = z.union([
  z.object({ id, deleted: z.literal(true) }).strict(),
  z
    .object({ id, deleted: z.literal(false), code: z.enum(['schedule_not_found', 'schedule_conflict']) })
    .strict(),
  scheduleToolFailureSchema,
])
