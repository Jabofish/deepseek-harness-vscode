import { z } from 'zod'
import { id, requestBase } from './request-common.js'

export const presetRequestSchemas = [
  z.object({ type: z.literal('plugin.inventory'), ...requestBase }).strict(),
  z.object({ type: z.literal('preset.list'), ...requestBase }).strict(),
  z
    .object({ type: z.literal('preset.read'), ...requestBase, payload: z.object({ presetId: id }).strict() })
    .strict(),
  z
    .object({
      type: z.literal('preset.copy'),
      ...requestBase,
      payload: z.object({ from: id, presetId: id, name: z.string().max(256).optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('preset.openDocument'),
      ...requestBase,
      payload: z.object({ presetId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('preset.remove'),
      ...requestBase,
      payload: z.object({ presetId: id }).strict(),
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
  z.object({ type: z.literal('diagnostics.snapshot'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('view.openLink'),
      ...requestBase,
      payload: z.object({ href: z.string().min(1).max(4_096) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('view.showInFolder'),
      ...requestBase,
      payload: z.object({ href: z.string().min(1).max(4_096) }).strict(),
    })
    .strict(),
] as const
