import { z } from 'zod'
import { protocolAppErrorCodeSchema } from './feature-schemas.js'
import { id, wireVersion, MAX_HOST_ERROR_MESSAGE_CHARS, boundedUnknown } from './request-common.js'
import { budgetFailure } from './protocol-budget.js'
import { webviewRequestSchema } from './webview-request-schema.js'

const hostError = z
  .object({
    code: protocolAppErrorCodeSchema,
    message: z.string().min(1).max(MAX_HOST_ERROR_MESSAGE_CHARS),
    retryable: z.boolean(),
  })
  .strict()

export const hostResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      type: z.literal('response'),
      requestId: id,
      ok: z.literal(true),
      payload: boundedUnknown.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('response'),
      requestId: id,
      ok: z.literal(false),
      error: hostError,
    })
    .strict(),
])

const jobFollowSafeOffsetSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .refine((value) => !Object.is(value, -0))

const jobFollowOutputSchema = z
  .object({ total: jobFollowSafeOffsetSchema, earliest: jobFollowSafeOffsetSchema })
  .strict()
  .superRefine((value, context) => {
    if (value.earliest > value.total)
      context.addIssue({ code: 'custom', path: ['earliest'], message: 'earliest must not exceed total.' })
  })

const jobFollowJobViewSchema = z
  .object({
    id,
    kind: z.string().min(1),
    label: z.string().min(1),
    status: z.enum(['running', 'stopping', 'completed', 'failed', 'killed']),
    detail: z.string().optional(),
    progress: z.string().optional(),
    startedAt: jobFollowSafeOffsetSchema,
    finishedAt: jobFollowSafeOffsetSchema.optional(),
    output: jobFollowOutputSchema.optional(),
  })
  .strict()
  .transform((value) => ({
    id: value.id,
    kind: value.kind,
    label: value.label,
    status: value.status,
    startedAt: value.startedAt,
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    ...(value.progress === undefined ? {} : { progress: value.progress }),
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
    ...(value.output === undefined ? {} : { output: value.output }),
  }))

const jobFollowChunkSchema = z
  .object({
    at: jobFollowSafeOffsetSchema,
    text: z.string(),
    channel: z.enum(['stdout', 'stderr', 'log']).optional(),
    gapBefore: z.literal(true).optional(),
  })
  .strict()
  .transform((value) => ({
    at: value.at,
    text: value.text,
    ...(value.channel === undefined ? {} : { channel: value.channel }),
    ...(value.gapBefore === undefined ? {} : { gapBefore: value.gapBefore }),
  }))

export const jobFollowFrameSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('opened'), job: jobFollowJobViewSchema, from: jobFollowSafeOffsetSchema })
    .strict(),
  z
    .object({
      type: z.literal('output'),
      chunks: z.array(jobFollowChunkSchema).max(100_000),
      next: jobFollowSafeOffsetSchema,
      lossy: z.literal(true).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      const encoder = new TextEncoder()
      let previousEnd: number | undefined
      let lastByteEnd: number | undefined
      if (value.chunks.length === 0 && value.lossy !== true)
        context.addIssue({
          code: 'custom',
          path: ['chunks'],
          message: 'An empty output frame must mark a lossy cursor advance.',
        })
      for (const [index, chunk] of value.chunks.entries()) {
        const end = chunk.at + encoder.encode(chunk.text).byteLength
        if (!Number.isSafeInteger(end) || end > value.next)
          context.addIssue({
            code: 'custom',
            path: ['chunks', index],
            message: 'Chunk end must not exceed next.',
          })
        if (
          chunk.text.length === 0 &&
          (chunk.gapBefore !== true || value.lossy !== true || chunk.at !== value.next)
        )
          context.addIssue({
            code: 'custom',
            path: ['chunks', index, 'text'],
            message: 'An empty chunk must mark a lossy tail at next.',
          })
        if (previousEnd !== undefined && chunk.at < previousEnd)
          context.addIssue({
            code: 'custom',
            path: ['chunks', index, 'at'],
            message: 'Chunks must not overlap.',
          })
        if (previousEnd !== undefined && chunk.at > previousEnd && chunk.gapBefore !== true)
          context.addIssue({
            code: 'custom',
            path: ['chunks', index],
            message: 'An internal gap must be marked on its chunk.',
          })
        previousEnd = end
        if (chunk.text.length > 0) lastByteEnd = end
      }
      if (lastByteEnd !== undefined && lastByteEnd !== value.next)
        context.addIssue({
          code: 'custom',
          path: ['next'],
          message: 'Next must equal the end of the last byte-bearing chunk.',
        })
    })
    .transform((value) => ({
      type: value.type,
      chunks: value.chunks,
      next: value.next,
      ...(value.lossy === undefined ? {} : { lossy: value.lossy }),
    })),
  z.object({ type: z.literal('status'), job: jobFollowJobViewSchema }).strict(),
])

export const jobFollowUpdatedPayloadSchema = z
  .object({ sessionId: id, jobId: id, followId: id, frame: jobFollowFrameSchema })
  .strict()
  .superRefine((value, context) => {
    const failure = budgetFailure(value)
    if (failure !== undefined) context.addIssue({ code: 'custom', message: failure })
  })

export const jobFollowFailedPayloadSchema = z
  .object({
    sessionId: id,
    jobId: id,
    followId: id,
    reason: z.literal('stream-failed'),
  })
  .strict()

/**
 * Legacy compatibility envelope. New staged feature events must use the
 * closed `featureHostEventSchema`; generic backend events remain open, while
 * Job follow has exact schemas because its byte cursor controls resumed reads.
 */
const genericHostEventSchema = z
  .object({
    type: z.literal('event'),
    name: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (name) => name !== 'job.follow.updated' && name !== 'job.follow.failed' && name !== 'queue.updated',
      ),
    sequence: z.number().int().nonnegative(),
    payload: boundedUnknown,
  })
  .strict()

const queueUpdatedHostEventSchema = z
  .object({
    type: z.literal('event'),
    name: z.literal('queue.updated'),
    sequence: z.number().int().nonnegative(),
    // Keep legacy queue payloads open; validate the new optional projection
    // watermark without dropping older adapter fields.
    payload: boundedUnknown.superRefine((value, context) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return
      const payload = value as Record<string, unknown>
      if (!Object.hasOwn(payload, 'asOfSequence')) return
      const cut = payload.asOfSequence
      if (typeof cut !== 'number' || !Number.isSafeInteger(cut) || cut < 0 || Object.is(cut, -0))
        context.addIssue({
          code: 'custom',
          message: 'Queue projection sequence must be a safe non-negative integer.',
        })
    }),
  })
  .strict()

const jobFollowUpdatedHostEventSchema = z
  .object({
    type: z.literal('event'),
    name: z.literal('job.follow.updated'),
    sequence: jobFollowSafeOffsetSchema,
    payload: jobFollowUpdatedPayloadSchema,
  })
  .strict()

const jobFollowFailedHostEventSchema = z
  .object({
    type: z.literal('event'),
    name: z.literal('job.follow.failed'),
    sequence: jobFollowSafeOffsetSchema,
    payload: jobFollowFailedPayloadSchema,
  })
  .strict()

export const hostEventSchema = z.union([
  queueUpdatedHostEventSchema,
  jobFollowUpdatedHostEventSchema,
  jobFollowFailedHostEventSchema,
  genericHostEventSchema,
])

export const hostMessageSchema = z.union([hostResponseSchema, hostEventSchema])

export const webviewEnvelopeSchema = z
  .object({ protocolVersion: wireVersion, message: webviewRequestSchema })
  .strict()

export const hostEnvelopeSchema = z
  .object({ protocolVersion: wireVersion, message: hostMessageSchema })
  .strict()
