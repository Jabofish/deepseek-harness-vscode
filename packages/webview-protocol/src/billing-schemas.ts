import { z } from 'zod'
import {
  isBillingCondition,
  isBillingIdentifier,
  isBillingRate,
  type BillingCondition,
  type BillingPrice,
  type BillingSettings,
  type BillingCandidate,
  type BillingCurrencyDisplay,
} from '@dsh-vscode/domain'

const id = z.string().min(1).max(256).refine(isBillingIdentifier)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const rate = z
  .string()
  .max(19)
  .refine(isBillingRate, 'Use a non-negative decimal with at most nine fractional digits.')
const amount = z
  .string()
  .max(64)
  .regex(/^\d{1,40}(\.\d{1,15})?$/)
const currency = z.string().regex(/^[A-Z]{3}$/)
const route = z.object({ providerId: id, modelId: id }).strict()
const category = z.enum(['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'])
const issue = z.enum([
  'missing-route',
  'missing-price',
  'missing-usage',
  'invalid-usage',
  'unknown-cache',
  'unknown-reasoning',
  'unknown-price-period',
])
const tokenSum = z.string().regex(/^\d{1,24}$/u)
const condition = z.custom<BillingCondition>(isBillingCondition)
export const billingPriceSchema = route
  .extend({
    currency,
    input: rate,
    output: rate,
    cacheRead: rate.optional(),
    cacheWrite: rate.optional(),
    reasoning: rate.optional(),
    multipliers: z
      .array(z.object({ when: condition, factor: rate }).strict())
      .max(16)
      .optional(),
    overrides: z
      .array(
        z
          .object({
            when: condition,
            rates: z.partialRecord(category, rate),
            unavailable: z.array(category).max(3).optional(),
          })
          .strict()
          .transform((v) => ({
            when: v.when,
            rates: v.rates,
            ...(v.unavailable === undefined ? {} : { unavailable: v.unavailable }),
          })),
      )
      .max(32)
      .optional(),
    validFrom: integer.optional(),
    validUntil: integer.optional(),
  })
  .strict()
  .transform((value): BillingPrice => ({
    providerId: value.providerId,
    modelId: value.modelId,
    currency: value.currency,
    input: value.input,
    output: value.output,
    ...(value.cacheRead === undefined ? {} : { cacheRead: value.cacheRead }),
    ...(value.cacheWrite === undefined ? {} : { cacheWrite: value.cacheWrite }),
    ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
    ...(value.multipliers === undefined ? {} : { multipliers: value.multipliers }),
    ...(value.overrides === undefined ? {} : { overrides: value.overrides }),
    ...(value.validFrom === undefined ? {} : { validFrom: value.validFrom }),
    ...(value.validUntil === undefined ? {} : { validUntil: value.validUntil }),
  }))
  .refine(
    (p) => p.validFrom === undefined || p.validUntil === undefined || p.validFrom < p.validUntil,
    'The price validity range must be ordered.',
  )
const mapping = route.extend({ referenceProviderId: id, referenceModelId: id }).strict()
const configuration = z
  .object({
    enabled: z.boolean(),
    prices: z.array(billingPriceSchema).max(256),
    automatic: z.boolean().optional(),
    mappings: z.array(mapping).max(256).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const byRoute = new Map<string, BillingPrice[]>()
    for (const price of value.prices) {
      const key = JSON.stringify([price.providerId, price.modelId])
      const previous = byRoute.get(key) ?? []
      if (
        previous.some(
          (p) =>
            (p.validFrom ?? -Infinity) < (price.validUntil ?? Infinity) &&
            (price.validFrom ?? -Infinity) < (p.validUntil ?? Infinity),
        )
      )
        ctx.addIssue({ code: 'custom', message: 'Price validity periods for one model must not overlap.' })
      previous.push(price)
      byRoute.set(key, previous)
    }
    const mappings = value.mappings?.map((p) => JSON.stringify([p.providerId, p.modelId])) ?? []
    if (new Set(mappings).size !== mappings.length)
      ctx.addIssue({ code: 'custom', message: 'A model route must have exactly one mapping.' })
  })
const cleanConfiguration = (value: z.infer<typeof configuration>): Omit<BillingSettings, 'revision'> => ({
  enabled: value.enabled,
  prices: value.prices,
  ...(value.automatic === undefined ? {} : { automatic: value.automatic }),
  ...(value.mappings === undefined ? {} : { mappings: value.mappings }),
})
export const billingConfigurationSchema = configuration.transform(cleanConfiguration)
export const billingSettingsSchema = configuration
  .safeExtend({ revision: integer })
  .transform((value): BillingSettings => ({ ...cleanConfiguration(value), revision: value.revision }))
export const billingSettingsResponseSchema = z
  .object({ kind: z.literal('billing.settings'), scopeId: id, settings: billingSettingsSchema })
  .strict()
const charge = z
  .object({
    category: z.enum(['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning']),
    tokens: integer,
    rate,
    amount,
  })
  .strict()
const entry = z
  .object({
    sequence: integer,
    kind: z.enum(['message', 'attempt']),
    route: route.optional(),
    currency: currency.optional(),
    amount: amount.optional(),
    charges: z.array(charge).max(5),
    issues: z.array(issue).max(7),
  })
  .strict()
const breakdown = z
  .object({
    currency,
    category,
    tokens: tokenSum,
    amount,
    rates: z.array(z.object({ rate, tokens: tokenSum, amount }).strict()).max(32),
    ratesTruncated: z.boolean(),
  })
  .strict()
const display = z
  .object({
    currency: z.enum(['CNY', 'USD']),
    status: z.enum(['native', 'converted', 'unavailable']),
    exchange: z
      .union([
        z
          .object({
            usdCny: rate.refine((value) => Number(value) > 0),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
          })
          .strict(),
        z.object({ usdCny: z.literal('6.8'), fallback: z.literal(true) }).strict(),
      ])
      .optional(),
    totals: z.array(z.object({ currency, amount }).strict()).max(256),
    breakdown: z
      .array(
        breakdown.extend({
          rates: z.array(z.object({ rate: amount, tokens: tokenSum, amount }).strict()).max(32),
        }),
      )
      .max(1280),
  })
  .strict()
  .transform((value): BillingCurrencyDisplay => ({
    currency: value.currency,
    status: value.status,
    totals: value.totals,
    breakdown: value.breakdown,
    ...(value.exchange === undefined ? {} : { exchange: value.exchange }),
  }))
export const billingEstimateSchema = z
  .object({
    sessionId: id,
    enabled: z.boolean(),
    supported: z.boolean(),
    historyComplete: z.boolean(),
    scannedEvents: integer,
    requests: integer,
    pricedRequests: integer,
    partialRequests: integer,
    unpricedRequests: integer,
    priceRevision: integer,
    totals: z.array(z.object({ currency, amount }).strict()).max(256),
    breakdown: z.array(breakdown).max(1280),
    display: display.optional(),
    issueCounts: z.array(z.object({ issue, count: integer, attempts: integer }).strict()).max(7),
    entries: z.array(entry).max(100),
    detailsTruncated: z.boolean(),
  })
  .strict()
export const billingEstimateResponseSchema = z
  .object({ kind: z.literal('billing.estimate'), estimate: billingEstimateSchema })
  .strict()
export const billingReferenceResponseSchema = z
  .object({
    kind: z.literal('billing.reference'),
    status: z.enum(['found', 'missing', 'unsupported']),
    price: billingPriceSchema.optional(),
    fetchedAt: z.string().datetime(),
  })
  .strict()
const candidate = route
  .extend({ label: z.string().min(1).max(512), official: z.boolean().optional() })
  .strict()
  .transform((value): BillingCandidate => ({
    providerId: value.providerId,
    modelId: value.modelId,
    label: value.label,
    ...(value.official === undefined ? {} : { official: value.official }),
  }))
export const billingReferencesResponseSchema = z
  .object({
    kind: z.literal('billing.references'),
    entries: z.array(candidate).max(50),
    hasMore: z.boolean(),
    nextOffset: integer,
    fetchedAt: z.string().datetime(),
  })
  .strict()
export const billingCatalogResponseSchema = z
  .object({
    kind: z.literal('billing.catalog'),
    scopeId: id,
    revision: integer,
    entries: z
      .array(
        route
          .extend({
            label: z.string().min(1).max(512),
            status: z.enum(['automatic', 'manual', 'missing', 'ambiguous', 'unsupported', 'unavailable']),
            price: billingPriceSchema.optional(),
            reference: candidate.optional(),
            candidates: z.array(candidate).max(8),
          })
          .strict(),
      )
      .max(50),
    hasMore: z.boolean(),
    nextOffset: integer,
  })
  .strict()
export const billingRequestSchemas = [
  z
    .object({
      type: z.literal('billing.reference.search'),
      requestId: id,
      payload: z.object({ query: z.string().max(128), offset: integer.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('billing.catalog.read'),
      requestId: id,
      payload: z.object({ offset: integer.optional(), query: z.string().max(128).optional() }).strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('billing.settings.read'), requestId: id, payload: z.object({}).strict() })
    .strict(),
  z
    .object({
      type: z.literal('billing.settings.save'),
      requestId: id,
      payload: z
        .object({ scopeId: id, expectedRevision: integer, settings: billingConfigurationSchema })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('billing.estimate'),
      requestId: id,
      payload: z.object({ sessionId: id, currency: z.enum(['CNY', 'USD']).optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('billing.reference.read'),
      requestId: id,
      payload: z.object({ providerId: id, modelId: id }).strict(),
    })
    .strict(),
] as const
export type BillingSettingsResponse = z.infer<typeof billingSettingsResponseSchema>
export type BillingCatalogResponse = z.infer<typeof billingCatalogResponseSchema>
export type BillingReferenceResponse = z.infer<typeof billingReferenceResponseSchema>
export type BillingEstimateResponse = z.infer<typeof billingEstimateResponseSchema>
export type BillingReferencesResponse = z.infer<typeof billingReferencesResponseSchema>
