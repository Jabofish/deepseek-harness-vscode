import type { TokenUsage } from './models.js'
import { billingPriceForFact } from './billing-periods.js'
import type { BillingCurrencyDisplay } from './billing-currency.js'

/** Money is a decimal string in its original currency. Prices are per million tokens. */
export interface BillingPrice {
  readonly providerId: string
  readonly modelId: string
  readonly currency: string
  readonly input: string
  readonly output: string
  readonly cacheRead?: string
  readonly cacheWrite?: string
  readonly reasoning?: string
  readonly multipliers?: readonly BillingMultiplier[]
  readonly validFrom?: number
  readonly validUntil?: number
  readonly overrides?: readonly BillingRateOverride[]
}

export type BillingCondition =
  | { readonly all: readonly BillingCondition[] }
  | { readonly any: readonly BillingCondition[] }
  | { readonly not: BillingCondition }
  | { readonly utcHours: { readonly gte?: string; readonly lt?: string } }
  | { readonly utcDays: readonly number[] }
  | { readonly holiday: string }
  | { readonly serviceTier: { readonly equals: string } }
  | {
      readonly context: {
        readonly gt?: number
        readonly gte?: number
        readonly lt?: number
        readonly lte?: number
      }
    }
  | { readonly date: { readonly gte?: string; readonly lt?: string } }
export interface BillingMultiplier {
  readonly when: BillingCondition
  readonly factor: string
}
export interface BillingRateOverride {
  readonly when: BillingCondition
  readonly rates: Partial<Readonly<Record<BillingCategory, string>>>
  readonly unavailable?: readonly BillingCategory[]
}
export function isBillingCondition(value: unknown): value is BillingCondition {
  let budget = 128
  const read = (value: unknown, depth: number): boolean => {
    if (--budget < 0 || depth > 6 || typeof value !== 'object' || value === null || Array.isArray(value))
      return false
    const data = value as Record<string, unknown>
    const keys = Object.keys(data)
    if (keys.length !== 1) return false
    if (keys[0] === 'all' || keys[0] === 'any') {
      const items = data[keys[0]]
      return (
        Array.isArray(items) &&
        items.length > 0 &&
        items.length <= 16 &&
        items.every((v) => read(v, depth + 1))
      )
    }
    if (keys[0] === 'not') return read(data.not, depth + 1)
    if (keys[0] === 'holiday') return typeof data.holiday === 'string' && /^[A-Z]{2}$/.test(data.holiday)
    if (keys[0] === 'serviceTier') {
      const tier = data.serviceTier
      if (typeof tier !== 'object' || tier === null || Array.isArray(tier)) return false
      const record = tier as Record<string, unknown>
      return (
        Object.keys(record).length === 1 &&
        typeof record.equals === 'string' &&
        /^[\w.-]{1,64}$/u.test(record.equals)
      )
    }
    if (keys[0] === 'context' || keys[0] === 'date') {
      const field = data[keys[0]]
      if (typeof field !== 'object' || field === null || Array.isArray(field)) return false
      const entries = Object.entries(field)
      return (
        entries.length > 0 &&
        entries.every(([key, value]) =>
          keys[0] === 'context'
            ? ['gt', 'gte', 'lt', 'lte'].includes(key) &&
              typeof value === 'number' &&
              Number.isSafeInteger(value) &&
              value >= 0
            : ['gte', 'lt'].includes(key) &&
              typeof value === 'string' &&
              /^\d{4}-\d{2}-\d{2}$/.test(value) &&
              !Number.isNaN(Date.parse(value)),
        )
      )
    }
    if (keys[0] === 'utcDays')
      return (
        Array.isArray(data.utcDays) &&
        data.utcDays.length > 0 &&
        data.utcDays.length <= 7 &&
        data.utcDays.every((v) => Number.isInteger(v) && v >= 0 && v <= 6)
      )
    if (
      keys[0] !== 'utcHours' ||
      typeof data.utcHours !== 'object' ||
      data.utcHours === null ||
      Array.isArray(data.utcHours)
    )
      return false
    const hours = data.utcHours as Record<string, unknown>
    return (
      Object.keys(hours).length > 0 &&
      Object.keys(hours).every(
        (key) =>
          ['gte', 'lt'].includes(key) &&
          typeof hours[key] === 'string' &&
          /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hours[key]),
      )
    )
  }
  return read(value, 0)
}
export interface BillingMapping extends BillingRoute {
  readonly referenceProviderId: string
  readonly referenceModelId: string
}
export interface BillingCandidate extends BillingRoute {
  readonly label: string
  readonly official?: boolean
}
export interface BillingCatalogEntry extends BillingRoute {
  readonly label: string
  readonly status: 'automatic' | 'manual' | 'missing' | 'ambiguous' | 'unsupported' | 'unavailable'
  readonly price?: BillingPrice
  readonly reference?: BillingCandidate
  readonly candidates: readonly BillingCandidate[]
}

export interface BillingSettings {
  readonly revision: number
  readonly enabled: boolean
  readonly prices: readonly BillingPrice[]
  readonly automatic?: boolean
  readonly mappings?: readonly BillingMapping[]
}

export interface BillingRoute {
  readonly providerId: string
  readonly modelId: string
}

/** Prompt-free facts. Only an exact version adapter may produce these. */
export type BillingFact =
  | { readonly kind: 'route'; readonly sequence: number; readonly route?: BillingRoute }
  | {
      readonly kind: 'message' | 'attempt'
      readonly sequence: number
      readonly route?: BillingRoute
      readonly usage?: TokenUsage
      readonly invalidUsage?: true
      readonly time?: number
      readonly startedAt?: number
      readonly serviceTier?: string
    }

export interface BillingUsagePage {
  readonly facts: readonly BillingFact[]
  readonly eventCount: number
  readonly contiguous: boolean
  readonly hasMore: boolean
  readonly fromSequence?: number
  readonly toSequence?: number
}

export interface BillingUsageRepository {
  readBillingPage(sessionId: string, beforeSequence?: number, signal?: AbortSignal): Promise<BillingUsagePage>
}

export type BillingCategory = 'input' | 'cacheRead' | 'cacheWrite' | 'output' | 'reasoning'
export type BillingIssue =
  | 'missing-route'
  | 'missing-price'
  | 'missing-usage'
  | 'invalid-usage'
  | 'unknown-cache'
  | 'unknown-reasoning'
  | 'unknown-price-period'

export interface BillingCharge {
  readonly category: BillingCategory
  readonly tokens: number
  readonly rate: string
  readonly amount: string
}

export interface BillingEntry {
  readonly sequence: number
  readonly kind: 'message' | 'attempt'
  readonly route?: BillingRoute
  readonly currency?: string
  readonly amount?: string
  readonly charges: readonly BillingCharge[]
  readonly issues: readonly BillingIssue[]
}

export interface BillingCostBreakdown {
  readonly category: BillingCategory
  readonly currency: string
  /** Aggregate token counts stay exact even when their sum exceeds Number.MAX_SAFE_INTEGER. */
  readonly tokens: string
  readonly amount: string
  readonly rates: readonly { readonly rate: string; readonly tokens: string; readonly amount: string }[]
  readonly ratesTruncated: boolean
}

export interface BillingIssueCount {
  readonly issue: BillingIssue
  readonly count: number
  readonly attempts: number
}

export interface BillingEstimate {
  readonly display?: BillingCurrencyDisplay
  readonly sessionId: string
  readonly enabled: boolean
  readonly supported: boolean
  /** Full history coverage, independent of which requests could be priced. */
  readonly historyComplete: boolean
  readonly scannedEvents: number
  readonly requests: number
  readonly pricedRequests: number
  readonly partialRequests: number
  readonly unpricedRequests: number
  readonly priceRevision: number
  readonly totals: readonly { readonly currency: string; readonly amount: string }[]
  readonly breakdown: readonly BillingCostBreakdown[]
  readonly issueCounts: readonly BillingIssueCount[]
  readonly entries: readonly BillingEntry[]
  readonly detailsTruncated: boolean
}

/** Bounded canonical decimal input; empty and zero have different meanings. */
export function isBillingRate(value: string): boolean {
  return /^(0|[1-9]\d{0,8})(\.\d{1,9})?$/.test(value)
}

export function isBillingIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= 256 &&
    !value.includes('://') &&
    !/^(?:[a-z]:[\\/]|[\\/])/i.test(value) &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
}

const MONEY_SCALE = 10n ** 15n

function units(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.')
  return BigInt(whole) * MONEY_SCALE + BigInt(fraction.padEnd(15, '0'))
}

function money(value: bigint): string {
  const fraction = (value % MONEY_SCALE).toString().padStart(15, '0').replace(/0+$/, '')
  return `${value / MONEY_SCALE}${fraction === '' ? '' : `.${fraction}`}`
}

export function addBillingAmounts(values: readonly string[]): string {
  return money(values.reduce((sum, value) => sum + units(value), 0n))
}

/** Summarize the entire scanned history before the request-detail display is bounded. */
export function summarizeBillingEntries(
  entries: readonly BillingEntry[],
): Pick<BillingEstimate, 'breakdown' | 'issueCounts'> {
  type Sum = { tokens: bigint; amount: bigint }
  const groups = new Map<
    string,
    {
      category: BillingCategory
      currency: string
      total: Sum
      rates: Map<string, Sum>
      ratesTruncated: boolean
    }
  >()
  const issues = new Map<BillingIssue, { count: number; attempts: number }>()
  for (const entry of entries) {
    for (const issue of new Set(entry.issues)) {
      const previous = issues.get(issue) ?? { count: 0, attempts: 0 }
      previous.count++
      if (entry.kind === 'attempt') previous.attempts++
      issues.set(issue, previous)
    }
    if (entry.currency === undefined) continue
    for (const charge of entry.charges) {
      const key = JSON.stringify([entry.currency, charge.category])
      const group = groups.get(key) ?? {
        category: charge.category,
        currency: entry.currency,
        total: { tokens: 0n, amount: 0n },
        rates: new Map<string, Sum>(),
        ratesTruncated: false,
      }
      group.total.tokens += BigInt(charge.tokens)
      group.total.amount += units(charge.amount)
      const rateKey = money(units(charge.rate))
      const rate = group.rates.get(rateKey)
      if (rate !== undefined || group.rates.size < 32) {
        const sum = rate ?? { tokens: 0n, amount: 0n }
        sum.tokens += BigInt(charge.tokens)
        sum.amount += units(charge.amount)
        group.rates.set(rateKey, sum)
      } else group.ratesTruncated = true
      groups.set(key, group)
    }
  }
  const value = (sum: Sum): { tokens: string; amount: string } => ({
    tokens: String(sum.tokens),
    amount: money(sum.amount),
  })
  return {
    breakdown: [...groups.values()].map((group) => ({
      category: group.category,
      currency: group.currency,
      ...value(group.total),
      rates: [...group.rates].map(([rate, sum]) => ({ rate, ...value(sum) })),
      ratesTruncated: group.ratesTruncated,
    })),
    issueCounts: [...issues].map(([issue, counts]) => ({ issue, ...counts })),
  }
}

function charge(category: BillingCategory, tokens: number, rate: string): BillingCharge {
  const [whole = '0', fraction = ''] = rate.split('.')
  const rateUnits = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'))
  return { category, tokens, rate, amount: money(BigInt(tokens) * rateUnits) }
}

function tokenCount(value: number | undefined): boolean {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
}

function normalizedUsage(usage: TokenUsage): TokenUsage | undefined {
  if (!tokenCount(usage.inputTokens) || !tokenCount(usage.outputTokens)) return undefined
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'reasoningTokens'] as const)
    if (usage[key] !== undefined && !tokenCount(usage[key])) return undefined
  if (usage.reasoningTokens !== undefined && usage.reasoningTokens > usage.outputTokens) return undefined
  let read = usage.cacheReadTokens
  let write = usage.cacheWriteTokens
  const sum = usage.inputTokens + usage.outputTokens + (read ?? 0) + (write ?? 0)
  if (!Number.isSafeInteger(sum)) return undefined
  if (usage.totalTokens !== undefined) {
    const remainder = usage.totalTokens - sum
    if (remainder < 0 || (read !== undefined && write !== undefined && remainder !== 0)) return undefined
    if (remainder === 0) {
      read ??= 0
      write ??= 0
    } else if (read === undefined && write !== undefined) read = remainder
    else if (write === undefined && read !== undefined) write = remainder
  }
  return {
    ...usage,
    ...(read === undefined ? {} : { cacheReadTokens: read }),
    ...(write === undefined ? {} : { cacheWriteTokens: write }),
  }
}

/** Pure per-request accounting. Reasoning replaces its output share, never adds to it. */
export function estimateBillingEntry(
  fact: Exclude<BillingFact, { readonly kind: 'route' }>,
  route: BillingRoute | undefined,
  price: BillingPrice | undefined,
): BillingEntry {
  const base = { sequence: fact.sequence, kind: fact.kind, ...(route === undefined ? {} : { route }) }
  const issue = (value: BillingIssue): BillingEntry => ({ ...base, charges: [], issues: [value] })
  if (fact.invalidUsage === true) return issue('invalid-usage')
  if (fact.usage === undefined) return issue('missing-usage')
  const usage = normalizedUsage(fact.usage)
  if (usage === undefined) return issue('invalid-usage')
  if (route === undefined) return issue('missing-route')
  if (price === undefined || price.providerId !== route.providerId || price.modelId !== route.modelId)
    return issue('missing-price')
  if (
    [price.input, price.output, price.cacheRead, price.cacheWrite, price.reasoning].some(
      (value) => value !== undefined && !isBillingRate(value),
    )
  )
    return issue('missing-price')
  if (
    price.multipliers?.some((rule) => !isBillingCondition(rule.when) || !isBillingRate(rule.factor)) ||
    price.overrides?.some(
      (rule) =>
        !isBillingCondition(rule.when) || Object.values(rule.rates).some((value) => !isBillingRate(value)),
    )
  )
    return issue('missing-price')
  const resolved = billingPriceForFact(price, { ...fact, usage })
  if (resolved === undefined) return issue('unknown-price-period')
  price = resolved
  const charges: BillingCharge[] = []
  const issues = new Set<BillingIssue>()
  const add = (category: BillingCategory, tokens: number | undefined, rate: string | undefined): void => {
    if (tokens === undefined) {
      issues.add('unknown-cache')
      return
    }
    if (tokens === 0) return
    if (rate === undefined) issues.add('missing-price')
    else charges.push(charge(category, tokens, rate))
  }
  add('input', usage.inputTokens, price.input)
  add('cacheRead', usage.cacheReadTokens, price.cacheRead)
  add('cacheWrite', usage.cacheWriteTokens, price.cacheWrite)
  if (
    price.reasoning !== undefined &&
    units(price.reasoning) !== units(price.output) &&
    usage.outputTokens > 0
  ) {
    if (usage.reasoningTokens === undefined) issues.add('unknown-reasoning')
    else {
      add('output', usage.outputTokens - usage.reasoningTokens, price.output)
      add('reasoning', usage.reasoningTokens, price.reasoning)
    }
  } else add('output', usage.outputTokens, price.output)
  return {
    ...base,
    currency: price.currency,
    amount: addBillingAmounts(charges.map((x) => x.amount)),
    charges,
    issues: [...issues],
  }
}
