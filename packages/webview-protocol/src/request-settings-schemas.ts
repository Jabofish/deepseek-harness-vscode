import { z } from 'zod'
import {
  id,
  requestBase,
  questionAnswerSchema,
  boundedUnknown,
  settingsRevision,
  settingsOperationSchema,
  customProviderModelSchema,
} from './request-common.js'

export const settingsRequestSchemas = [
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
      type: z.literal('provider.custom.create'),
      ...requestBase,
      payload: z
        .object({
          settingsNamespace: id,
          collectionPath: z.array(id).min(1).max(32),
          providerId: id,
          displayName: z.string().max(512).optional(),
          api: z.string().min(1).max(128),
          baseUrl: z.string().min(1).max(2048),
          models: z.array(customProviderModelSchema).min(1).max(1024),
          expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('plugin.credential.configure'),
      ...requestBase,
      payload: z.object({ ref: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('plugin.credential.remove'),
      ...requestBase,
      payload: z.object({ ref: id }).strict(),
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
        .object({
          questionId: id,
          response: z.union([
            z.string().max(100_000),
            z.array(id).max(32),
            z.array(questionAnswerSchema).max(64),
          ]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('interaction.question.cancel'),
      ...requestBase,
      payload: z.object({ questionId: id }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('settings.read'), ...requestBase }).strict(),
  z.object({ type: z.literal('settings.openDocument'), ...requestBase }).strict(),
  z.object({ type: z.literal('settings.openKeyboardShortcuts'), ...requestBase }).strict(),
  // Extension-local facts (connection/runtime defaults). The DSH host settings
  // snapshot travels on settings.read; the two must not be conflated.
  z.object({ type: z.literal('extensionSettings.read'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('settings.update'),
      ...requestBase,
      payload: z
        .object({
          path: z.string().min(1).max(512),
          value: boundedUnknown,
          expectedRevision: settingsRevision,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('settings.unset'),
      ...requestBase,
      payload: z.object({ path: z.string().min(1).max(512), expectedRevision: settingsRevision }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('settings.mutate'),
      ...requestBase,
      payload: z
        .object({
          namespace: z.string().trim().min(1).max(256),
          expectedRevision: settingsRevision,
          operations: z.array(settingsOperationSchema).min(1).max(128),
        })
        .strict(),
    })
    .strict(),
] as const
