import { z } from 'zod'
import { featureRelativePathSchema, generation, id, safeLabel, timestamp } from './feature-shared.js'

export const checkpointSummarySchema = z
  .object({
    checkpointId: id,
    sessionId: id,
    workspaceFolderId: id,
    createdAt: timestamp,
    label: safeLabel.optional(),
    fileCount: z.number().int().nonnegative().max(100_000),
    totalBytes: z
      .number()
      .int()
      .nonnegative()
      .max(2 * 1024 * 1024 * 1024),
    state: z.enum(['metadata-only', 'content-ready', 'stale', 'corrupt', 'partial-restore', 'deleted']),
    restoreAllowed: z.boolean(),
    contentEnabled: z.boolean(),
    expectedRevision: generation.optional(),
  })
  .strict()

export const checkpointFilePreviewSchema = z
  .object({
    relativePath: featureRelativePathSchema,
    presentAtCheckpoint: z.boolean(),
    expectedCurrentHash: z.string().max(256).optional(),
    currentHash: z.string().max(256).optional(),
    conflict: z.boolean(),
    byteSize: z
      .number()
      .int()
      .nonnegative()
      .max(2 * 1024 * 1024 * 1024),
  })
  .strict()

export const checkpointPreviewSchema = z
  .object({
    previewId: id,
    summary: checkpointSummarySchema,
    files: z.array(checkpointFilePreviewSchema).max(100),
    conflictCount: z.number().int().nonnegative().max(100),
  })
  .strict()

export const promptTemplateSummarySchema = z
  .object({
    templateId: id,
    title: safeLabel,
    description: z.string().max(2_000),
    scope: z.enum(['workspace', 'global', 'session']),
    updatedAt: timestamp,
    variables: z
      .array(
        z.enum([
          'selection',
          'currentFile',
          'currentDiagnostics',
          'currentSymbol',
          'workspaceName',
          'sessionTitle',
        ]),
      )
      .max(64),
    enabled: z.boolean(),
  })
  .strict()
