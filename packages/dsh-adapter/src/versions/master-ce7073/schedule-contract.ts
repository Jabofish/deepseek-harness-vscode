import { z } from 'zod'

/**
 * Wire preparation for upstream commit ce7073d51254c26cd63b22a60835b8f948deb447.
 * This is not registered as an Adapter: that source tree reports the same
 * version as the already-published alpha.2 package, whose Schedule wire differs.
 */
const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() !== '')
const text = z
  .string()
  .min(1)
  .refine((value) => value.trim() !== '')
const timestamp = z.iso.datetime().refine((value) => {
  const instant = Date.parse(value)
  return !value.startsWith('0000-') && Number.isFinite(instant) && new Date(instant).toISOString() === value
})
const weekdays = z
  .array(z.number().int().min(1).max(7))
  .min(1)
  .max(7)
  .refine((values) => new Set(values).size === values.length)
const common = {
  id: identifier,
  title: z.string().min(1).max(120),
  prompt: text,
  scheduledAt: timestamp,
}
const safeCreateSpec = z.object({ agentPreset: identifier.optional() })
const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: identifier }),
  z.object({ kind: z.literal('new_once'), sessionId: identifier, create: safeCreateSpec }),
  z.object({ kind: z.literal('new'), create: safeCreateSpec }),
])
const receipt = z.object({
  scheduledAt: timestamp,
  deliveredAt: timestamp,
  messageId: identifier,
  targetSessionId: identifier,
})
const catalogFields = {
  ...common,
  target,
  involvedSessionIds: z.array(identifier).max(10_000),
  status: z.enum(['active', 'paused', 'ended']),
  createdAt: timestamp.optional(),
  updatedAt: timestamp.optional(),
  executionActive: z.literal(true).optional(),
  deliveryFloorEndsAt: timestamp.optional(),
  lastDelivery: receipt.optional(),
}
const entry = z.discriminatedUnion('kind', [
  z.object({ ...catalogFields, kind: z.literal('at') }),
  z.object({ ...catalogFields, kind: z.literal('after'), afterSeconds: z.number().int().positive().safe() }),
  z.object({ ...catalogFields, kind: z.literal('every'), everySeconds: z.number().int().min(60).safe() }),
  z.object({ ...catalogFields, kind: z.literal('daily'), time: text, timeZone: text }),
  z.object({
    ...catalogFields,
    kind: z.literal('weekly'),
    time: text,
    timeZone: text,
    weekdays,
  }),
  z.object({ ...catalogFields, kind: z.literal('cron'), expression: text, timeZone: text }),
  z.object({ ...catalogFields, kind: z.literal('rrule'), rrule: text }),
])
const catalog = z.array(entry).max(10_000)
const localAt = z.object({ date: text, time: text, time_zone: text }).strict()
const daily = z.object({ time: text, time_zone: text }).strict()
const weekly = daily.extend({ weekdays }).strict()
const cron = z.object({ expression: text, time_zone: text }).strict()
const timing = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('after'), after_seconds: z.number().int().positive().safe() }).strict(),
  z.object({ kind: z.literal('at'), at: z.union([text, localAt]) }).strict(),
  z.object({ kind: z.literal('every'), every_seconds: z.number().int().min(60).safe() }).strict(),
  z.object({ kind: z.literal('daily'), daily }).strict(),
  z.object({ kind: z.literal('weekly'), weekly }).strict(),
  z.object({ kind: z.literal('cron'), cron }).strict(),
  z.object({ kind: z.literal('rrule'), rrule: text }).strict(),
])
// `cwd` is Host-only. Parsing this request never authorises access to that path.
const createSpec = z.object({ cwd: text.optional(), agentPreset: identifier.optional() }).strict()
const targetRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: identifier }).strict(),
  z.object({ kind: z.literal('new_once'), create: createSpec.optional() }).strict(),
  z.object({ kind: z.literal('new'), create: createSpec.optional() }).strict(),
])
const title = z.string().refine((value) => value.trim().length > 0 && value.trim().length <= 120)
const prompt = z.string().refine((value) => value.trim().length > 0)
const createRequest = z.object({ title, prompt, timing, target: targetRequest.optional() }).strict()
const patch = z
  .object({
    title: title.optional(),
    prompt: prompt.optional(),
    timing: timing.optional(),
    target: targetRequest.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((item) => item !== undefined))
const editRequest = z.discriminatedUnion('action', [
  z
    .object({
      id: identifier,
      action: z.literal('update'),
      patch,
      expectedUpdatedAt: timestamp.nullable().optional(),
    })
    .strict(),
  z
    .object({
      id: identifier,
      action: z.literal('delete'),
      expectedUpdatedAt: timestamp.nullable().optional(),
    })
    .strict(),
])
const listRequest = z
  .object({
    active: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().nonnegative().safe().optional(),
  })
  .strict()
const historyRequest = z
  .object({ id: identifier, limit: z.number().int().min(1).max(100), before: identifier.optional() })
  .strict()
const idRequest = z.object({ id: identifier }).strict()
const notFound = z.object({ id: identifier, code: z.literal('schedule_not_found') })
const historyMiss = z.object({
  id: identifier,
  code: z.enum(['schedule_not_found', 'delivery_cursor_not_found']),
})
const historyPage = z.object({
  id: identifier,
  records: z.array(receipt.extend({ prompt: text.optional() })).max(100),
  earlierRecordsUnavailable: z.boolean(),
  earlierRecordsPruned: z.boolean(),
  retention: z.object({
    days: z.number().int().positive().safe(),
    records: z.number().int().positive().safe(),
  }),
  nextBefore: identifier.optional(),
})
const listResult = z
  .object({
    items: z.array(entry).max(500),
    shown: z.number().int().nonnegative().safe(),
    total: z.number().int().nonnegative().safe(),
    limit: z.number().int().min(1).max(500),
    offset: z.number().int().nonnegative().safe(),
  })
  .refine((result) => result.shown === result.items.length && result.shown <= result.limit)
  .refine((result) => result.shown === 0 || result.offset + result.shown <= result.total)
const editResult = z.union([
  entry,
  z.object({ id: identifier, deleted: z.literal(true) }),
  notFound,
  z.object({ id: identifier, code: z.literal('schedule_conflict') }),
])
const runResult = z.union([
  entry,
  notFound,
  z.object({ id: identifier, code: z.literal('schedule_execution_pending') }),
])

/** Parse the Host-wide catalogue without retaining creation paths in target.create. */
export function parseMasterScheduleCatalog(value: unknown): z.infer<typeof catalog> {
  return catalog.parse(value)
}

/** Validate native request bodies before the Host performs ownership checks. */
export function parseMasterScheduleCreateRequest(value: unknown): z.infer<typeof createRequest> {
  return createRequest.parse(value)
}

export function parseMasterScheduleEditRequest(value: unknown): z.infer<typeof editRequest> {
  return editRequest.parse(value)
}

export function parseMasterScheduleListRequest(value: unknown): z.infer<typeof listRequest> {
  return listRequest.parse(value)
}

export function parseMasterScheduleHistoryRequest(value: unknown): z.infer<typeof historyRequest> {
  return historyRequest.parse(value)
}

export function parseMasterScheduleIdRequest(value: unknown): z.infer<typeof idRequest> {
  return idRequest.parse(value)
}

export function parseMasterScheduleCreate(value: unknown): z.infer<typeof entry> {
  return entry.parse(value)
}

export function parseMasterScheduleDeleteInactive(value: unknown): { deleted: number } {
  return z.object({ deleted: z.number().int().nonnegative().safe() }).parse(value)
}

export function parseMasterScheduleDeliveryLimits(value: unknown): { newSessionIntervalSeconds: number } {
  return z.object({ newSessionIntervalSeconds: z.number().int().min(60).max(604_800) }).parse(value)
}

export function parseMasterScheduleList(value: unknown): z.infer<typeof listResult> {
  return listResult.parse(value)
}

export function parseMasterScheduleHistory(
  value: unknown,
  requestedId: string,
): z.infer<typeof historyPage | typeof historyMiss> {
  return matchingId(z.union([historyPage, historyMiss]).parse(value), requestedId)
}

export function parseMasterScheduleEdit(value: unknown, requestedId: string): z.infer<typeof editResult> {
  return matchingId(editResult.parse(value), requestedId)
}

export function parseMasterScheduleRun(value: unknown, requestedId: string): z.infer<typeof runResult> {
  return matchingId(runResult.parse(value), requestedId)
}

export function parseMasterScheduleView(
  value: unknown,
  requestedId: string,
): z.infer<typeof entry | typeof notFound> {
  return matchingId(z.union([entry, notFound]).parse(value), requestedId)
}

function matchingId<T extends { id: string }>(value: T, requestedId: string): T {
  if (value.id !== identifier.parse(requestedId)) throw new Error('Schedule response identity mismatch')
  return value
}
