import { AppError, isSubagentName } from '@dsh-vscode/domain'
import { z } from 'zod'

/** Pinned source paths and types are recorded in the sanitised contract fixture. */
export const rc222Identifier = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => {
    const hasControlCharacter = Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || code === 0x7f
    })
    return value.trim() !== '' && !hasControlCharacter
  })
export const rc222Sequence = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .refine((value) => !Object.is(value, -0))
const text = z.string().max(65_536)
const strings = z.array(text).max(5_000)

export const rc222CatalogFactSchema = z
  .object({
    version: z.literal(3),
    childId: rc222Identifier,
    childCreatedAt: rc222Sequence,
    name: z.string().refine(isSubagentName),
    mode: z.enum(['continuable', 'external']),
    label: text.optional(),
  })
  .strict()
  .refine((entry) => entry.mode !== 'continuable' || entry.label !== undefined)

export const rc222TeamModeSchema = z.object({ enabled: z.boolean() }).strict()
const teamTask = z
  .object({
    id: rc222Identifier,
    revision: rc222Sequence.min(1),
    subject: text,
    description: text,
    status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
    blockedBy: z.array(rc222Identifier).max(5_000),
    writeScopes: strings,
    ownerId: rc222Identifier.optional(),
    ownerName: text.optional(),
    ready: z.boolean(),
    writeScopeWarnings: strings,
  })
  .strict()
  .refine((task) => task.ownerName === undefined || task.ownerId !== undefined)

export const rc222TeamProjectionSchema = z
  .object({
    enabled: z.boolean(),
    tasks: z.array(teamTask).max(5_000),
    failure: text.optional(),
  })
  .strict()
  .superRefine((team, context) => {
    if (new Set(team.tasks.map((task) => task.id)).size !== team.tasks.length)
      context.addIssue({ code: 'custom', message: 'Duplicate Team task identity.' })
  })

const cleanup = z.object({ closeConfirmed: z.boolean(), cleanupError: text.optional() })
export const rc222McpStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('disabled') }).strict(),
  z.object({ state: z.literal('closed'), result: cleanup.strict() }).strict(),
  z.object({ state: z.literal('waiting-credentials'), lastError: text }).strict(),
  z.object({ state: z.literal('connecting'), attempt: rc222Sequence }).strict(),
  z.object({ state: z.literal('connected'), toolCount: rc222Sequence, connectedAt: rc222Sequence }).strict(),
  z
    .object({
      state: z.literal('reconnecting'),
      attempt: rc222Sequence,
      maxAttempts: rc222Sequence,
      nextRetryAtMs: rc222Sequence,
      lastError: text,
    })
    .strict(),
  z
    .object({
      state: z.literal('failed'),
      reason: z.enum(['gave-up', 'reconnect-disabled', 'unclosed-generation', 'load', 'cleanup']),
      lastError: text.optional(),
      result: cleanup.strict().optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        (value.reason === 'cleanup') !== (value.result !== undefined) ||
        (value.reason === 'load' && value.lastError === undefined) ||
        (value.reason === 'cleanup' && value.lastError !== undefined)
      )
        context.addIssue({ code: 'custom', message: 'MCP failure detail does not match its reason.' })
    }),
])
export function parseRc222Contract<T>(schema: z.ZodType<T>, value: unknown, method: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success)
    throw new AppError({
      code: 'PROTOCOL_ERROR',
      message: 'DSH returned a malformed rc222 contract response.',
      retryable: false,
      context: { rpcMethod: method },
    })
  return parsed.data
}

export function parseRc222Continuation(value: unknown, asOfSequence: number): number | null {
  const ending = parseRc222Contract(rc222Sequence.nullable(), value, 'conversationContinuation')
  if (
    !Number.isSafeInteger(asOfSequence) ||
    asOfSequence < -1 ||
    Object.is(asOfSequence, -0) ||
    (ending !== null && ending > asOfSequence)
  )
    throw new AppError({
      code: 'PROTOCOL_ERROR',
      message: 'DSH returned a continuation beyond its projection cursor.',
      retryable: false,
    })
  return ending
}
