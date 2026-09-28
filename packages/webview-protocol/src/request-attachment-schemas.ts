import { z } from 'zod'
import { id, requestBase, MAX_PROMPT_ATTACHMENTS, session, attachmentUri } from './request-common.js'
import { MAX_ATTACHMENT_BASE64_CHARS } from './protocol-budget.js'

export const attachmentRequestSchemas = [
  z.object({ type: z.literal('attachment.pick'), ...requestBase }).strict(),
  z
    .object({
      // Paste/drop bytes originate in the Webview; the Extension Host still
      // owns validation and storage and returns the same opaque handle.
      type: z.literal('attachment.ingest'),
      ...requestBase,
      payload: z
        .object({
          name: z.string().min(1).max(512),
          mimeType: z.string().max(256).optional(),
          // rc.2 permits 20 MiB images; the Extension Host still performs
          // MIME-aware validation and keeps non-image files at 8 MiB.
          dataBase64: z.string().min(1).max(MAX_ATTACHMENT_BASE64_CHARS),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('attachment.preview'),
      ...requestBase,
      payload: z.object({ uri: attachmentUri }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('attachment.release'),
      ...requestBase,
      payload: z.object({ uris: z.array(attachmentUri).min(1).max(MAX_PROMPT_ATTACHMENTS) }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('attachment.open.list'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('attachment.open.attach'),
      ...requestBase,
      payload: z.object({ candidateId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('attachment.read'),
      ...requestBase,
      payload: z.object({ sessionId: id, attachmentId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('reference.list'),
      ...requestBase,
      payload: z
        .object({
          sessionId: id,
          query: z.string().max(4_096),
          quoted: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('feedback.list'), ...requestBase, payload: z.object(session).strict() })
    .strict(),
  z
    .object({
      type: z.literal('feedback.toggle'),
      ...requestBase,
      payload: z
        .object({
          sessionId: id,
          messageId: id,
          rating: z.enum(['positive', 'negative']),
          note: z.string().max(16_384).optional(),
          category: z
            .enum([
              'task-result',
              'instruction-following',
              'product-interaction',
              'service-stability',
              'resource-cost',
              'security-privacy-permission',
              'other',
            ])
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('feedback.note'),
      ...requestBase,
      payload: z
        .object({
          sessionId: id,
          messageId: id,
          rating: z.enum(['positive', 'negative']),
          note: z.string().max(16_384).optional(),
          category: z
            .enum([
              'task-result',
              'instruction-following',
              'product-interaction',
              'service-stability',
              'resource-cost',
              'security-privacy-permission',
              'other',
            ])
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('feedback.remove'),
      ...requestBase,
      payload: z.object({ sessionId: id, messageId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('models.list'),
      ...requestBase,
      payload: z.object({ providerId: id.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('models.session.list'),
      ...requestBase,
      payload: z.object({ sessionId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('models.discover'),
      ...requestBase,
      payload: z
        .object({
          settingsNamespace: id,
          providerId: id.optional(),
          baseUrl: z.string().max(2048).optional(),
          api: z.string().max(128).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('models.discover.custom'),
      ...requestBase,
      payload: z
        .object({
          settingsNamespace: id,
          providerId: id.optional(),
          baseUrl: z.string().max(2048).optional(),
          api: z.string().max(128).optional(),
        })
        .strict(),
    })
    .strict(),
] as const
