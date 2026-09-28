import { z } from 'zod'
import {
  accountLifecycleErrorCodeSchema,
  accountLifecycleSnapshotSchema,
} from '../account-lifecycle-schemas.js'
import { changeSummarySchema, featureEventIdentitySchema, id, taskSummarySchema } from './feature-shared.js'
import { checkpointSummarySchema } from './feature-checkpoints.js'
import { contextKind } from './feature-requests.js'
import { featureResponseSchema } from './feature-responses.js'

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
