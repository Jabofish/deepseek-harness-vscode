import { z } from 'zod'

export const id = z.string().min(1).max(256)
export const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const positiveTimestamp = timestamp.refine((value) => value > 0, 'Timestamp must be positive.')
export const boundedText = z.string().max(16_000_000)
export const safeLabel = z.string().min(1).max(512)
export const MAX_CONTEXT_ITEMS = 8
export const MAX_CONTEXT_ITEM_BYTES = 64 * 1024
export const MAX_CONTEXT_TOTAL_BYTES = 256 * 1024

export function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 1_024) return false
  if (value.includes('\\') || value.includes(':') || value.startsWith('/') || /^[A-Za-z]:/u.test(value))
    return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return false
  if (containsControlCharacters(value)) return false
  const segments = value.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

export function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export const featureRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isSafeRelativePath, 'Only canonical workspace-relative paths are allowed.')

export const featureResourceScopeSchema = z
  .object({
    ownerId: id,
    workspaceFolderId: id,
    ownerViewId: id.optional(),
    sessionId: id.optional(),
    backendInstanceId: id.optional(),
    connectionGeneration: generation.optional(),
    expiresAt: positiveTimestamp,
  })
  .strict()

export const featureEventIdentityBase = {
  backendInstanceId: id,
  connectionGeneration: generation,
  eventId: id.optional(),
  rpcId: id.optional(),
  toolCallId: id.optional(),
}

export const featureEventIdentitySchema = z.discriminatedUnion('stream', [
  z
    .object({
      ...featureEventIdentityBase,
      stream: z.literal('mux'),
      sessionId: id,
      serverSeq: generation,
    })
    .strict(),
  z
    .object({
      ...featureEventIdentityBase,
      stream: z.literal('host'),
      sessionId: id.optional(),
      localSeq: generation,
    })
    .strict(),
  z
    .object({
      ...featureEventIdentityBase,
      stream: z.literal('local'),
      sessionId: id.optional(),
      localSeq: generation,
    })
    .strict(),
])

export const featurePositionSchema = z
  .object({
    line: z.number().int().nonnegative().max(1_000_000),
    column: z.number().int().nonnegative().max(1_000_000),
  })
  .strict()

export const featureRangeSchema = z
  .object({
    start: featurePositionSchema,
    end: featurePositionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.start.line > value.end.line ||
      (value.start.line === value.end.line && value.start.column > value.end.column)
    ) {
      context.addIssue({ code: 'custom', path: ['end'], message: 'Range end must not precede range start.' })
    }
  })

export const editorContextItemSchema = z
  .object({
    contextRef: id,
    kind: z.enum(['selection', 'open-document', 'diagnostic', 'symbol']),
    label: safeLabel,
    workspaceFolderId: id,
    relativePath: featureRelativePathSchema,
    sourceCandidateId: z
      .string()
      .regex(/^dsh-open-file-[a-f0-9]{32}$/u)
      .optional(),
    range: featureRangeSchema.optional(),
    sizeBytes: z.number().int().nonnegative().max(MAX_CONTEXT_ITEM_BYTES),
    documentVersion: generation.optional(),
    stale: z.boolean(),
    previewAvailable: z.boolean(),
    expiresAt: positiveTimestamp,
    scope: featureResourceScopeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope.workspaceFolderId !== value.workspaceFolderId) {
      context.addIssue({
        code: 'custom',
        path: ['scope', 'workspaceFolderId'],
        message: 'Resource scope must use the same workspace folder as the context item.',
      })
    }
  })

export const changeLocationSchema = z
  .object({
    relativePath: featureRelativePathSchema,
    line: z.number().int().nonnegative().max(1_000_000).optional(),
  })
  .strict()

export const changeSummarySchema = z
  .object({
    changeId: id,
    sessionId: id,
    workspaceFolderId: id,
    relativePath: featureRelativePathSchema,
    previousRelativePath: featureRelativePathSchema.optional(),
    status: z.enum(['added', 'modified', 'deleted', 'renamed', 'unknown']),
    additions: z.number().int().nonnegative().max(10_000_000).optional(),
    deletions: z.number().int().nonnegative().max(10_000_000).optional(),
    evidence: z.enum([
      'structured-proposal',
      'structured-tool-success',
      'filesystem-observed',
      'structured-location-only',
      'failed',
      'incomplete',
    ]),
    applicationState: z.enum(['proposed', 'applied-observed', 'failed', 'unknown']),
    reviewState: z.enum(['unreviewed', 'viewed', 'accepted', 'rejected', 'needs-attention']),
    sourceIds: z.array(id).max(16),
    locations: z.array(changeLocationSchema).max(32),
    firstSeenAt: positiveTimestamp,
    lastSeenAt: positiveTimestamp,
    identity: featureEventIdentitySchema,
    diffAvailable: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'renamed' && value.previousRelativePath === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['previousRelativePath'],
        message: 'Renamed changes must include their previous relative path.',
      })
    }
  })

export const taskSummarySchema = z
  .object({
    taskId: id,
    sourceId: id,
    sessionId: id.optional(),
    parentTaskId: id.optional(),
    workspaceFolderId: id,
    kind: z.enum(['session', 'subagent', 'job', 'goal', 'interaction', 'unknown']),
    title: safeLabel,
    sessionTitle: safeLabel.optional(),
    status: z.enum([
      'running',
      'idle',
      'needs-input',
      'blocked',
      'failed',
      'completed',
      'cancelled',
      'disconnected',
      'unknown',
    ]),
    needsUserAction: z.boolean(),
    actionKind: z.enum(['approval', 'question', 'configuration', 'none']).optional(),
    interactionId: id.optional(),
    modelLabel: z.string().max(256).optional(),
    providerLabel: z.string().max(256).optional(),
    startedAt: timestamp,
    updatedAt: timestamp,
    progress: z.number().min(0).max(1).optional(),
    childCount: z.number().int().nonnegative().max(10_000),
    canOpen: z.boolean(),
    canAnswer: z.boolean(),
    canSessionCancel: z.boolean(),
    ownerKind: z.enum(['extension', 'external', 'unknown']),
    backendInstanceId: id.optional(),
    connectionGeneration: generation.optional(),
    taskRevision: generation,
  })
  .strict()
