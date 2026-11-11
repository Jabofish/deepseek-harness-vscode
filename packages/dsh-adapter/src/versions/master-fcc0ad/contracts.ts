import { AppError, isSubagentName } from '@dsh-vscode/domain'
import { z } from 'zod'

/** Pinned source paths and types are recorded in the sanitised contract fixture. */
export const masterIdentifier = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => value.trim() !== '' && !/[\u0000-\u001f\u007f]/u.test(value))
export const masterSequence = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .refine((value) => !Object.is(value, -0))
const text = z.string().max(65_536)
const strings = z.array(text).max(5_000)

export const masterCatalogFactSchema = z
  .object({
    version: z.literal(3),
    childId: masterIdentifier,
    childCreatedAt: masterSequence,
    name: z.string().refine(isSubagentName),
    mode: z.enum(['continuable', 'external']),
    label: text.optional(),
  })
  .strict()
  .refine((entry) => entry.mode !== 'continuable' || entry.label !== undefined)

export const masterTeamModeSchema = z.object({ enabled: z.boolean() }).strict()
const teamTask = z
  .object({
    id: masterIdentifier,
    revision: masterSequence.min(1),
    subject: text,
    description: text,
    status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
    blockedBy: z.array(masterIdentifier).max(5_000),
    writeScopes: strings,
    ownerId: masterIdentifier.optional(),
    ownerName: text.optional(),
    ready: z.boolean(),
    writeScopeWarnings: strings,
  })
  .strict()
  .refine((task) => task.ownerName === undefined || task.ownerId !== undefined)

export const masterTeamProjectionSchema = z
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

const description = z.union([
  z.string().max(16_384),
  z
    .record(z.string().min(1).max(64), z.string().max(16_384))
    .refine((value) => Object.hasOwn(value, 'en') && Object.keys(value).length <= 64),
])
const provider = z
  .object({
    id: masterIdentifier,
    title: text.optional(),
    description: description.optional(),
  })
  .strict()
const providerList = z
  .array(provider)
  .max(5_000)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length)
export const masterWebProvidersSchema = z.object({ search: providerList, fetch: providerList }).strict()

const cleanup = z.object({ closeConfirmed: z.boolean(), cleanupError: text.optional() })
export const masterMcpStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('disabled') }).strict(),
  z.object({ state: z.literal('closed'), result: cleanup.strict() }).strict(),
  z.object({ state: z.literal('waiting-credentials'), lastError: text }).strict(),
  z.object({ state: z.literal('connecting'), attempt: masterSequence }).strict(),
  z
    .object({ state: z.literal('connected'), toolCount: masterSequence, connectedAt: masterSequence })
    .strict(),
  z
    .object({
      state: z.literal('reconnecting'),
      attempt: masterSequence,
      maxAttempts: masterSequence,
      nextRetryAtMs: masterSequence,
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
export const masterMcpServersSchema = z
  .array(
    z
      .object({
        name: masterIdentifier,
        configured: z.boolean(),
        status: masterMcpStatusSchema,
      })
      .strict(),
  )
  .max(5_000)
  .refine((items) => new Set(items.map((item) => item.name)).size === items.length)

const duration = z.number().finite().nonnegative()
export const masterMcpProbeSchema = z.discriminatedUnion('ok', [
  cleanup
    .extend({
      ok: z.literal(true),
      serverInfo: z.object({ name: text, version: text }).strict().optional(),
      toolNames: strings,
      truncated: z.boolean(),
      durationMs: duration,
    })
    .strict(),
  cleanup
    .extend({ ok: z.literal(false), stage: z.enum(['connect', 'list']), message: text, durationMs: duration })
    .strict(),
])

export function parseMasterContract<T>(schema: z.ZodType<T>, value: unknown, method: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success)
    throw new AppError({
      code: 'PROTOCOL_ERROR',
      message: 'DSH returned a malformed development-contract response.',
      retryable: false,
      context: { rpcMethod: method },
    })
  return parsed.data
}

export function parseMasterContinuation(value: unknown, asOfSequence: number): number | null {
  const ending = parseMasterContract(masterSequence.nullable(), value, 'conversationContinuation')
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
