import {
  AppError,
  addBillingAmounts,
  estimateBillingEntry,
  summarizeBillingEntries,
  billingCurrencyDisplay,
} from '@dsh-vscode/domain'
import type {
  BillingEstimate,
  BillingDisplayCurrency,
  BillingFact,
  BillingPrice,
  BillingRoute,
  BillingUsageRepository,
} from '@dsh-vscode/domain'
import type {
  BillingExchangeSource,
  BillingPriceResolver,
  BillingSettingsPort,
} from '../ports/billing-ports.js'

const MAX_BILLING_EVENTS = 100_000

/** No chat state, VS Code, HTTP or DSH wire dependencies. Reprices the chosen scope explicitly. */
export class BillingUseCases {
  public constructor(
    private readonly settings: BillingSettingsPort,
    private readonly automatic?: BillingPriceResolver,
    private readonly exchange?: BillingExchangeSource,
  ) {}

  public async estimate(
    sessionId: string,
    repository: BillingUsageRepository | undefined,
    signal: AbortSignal,
    currency?: BillingDisplayCurrency,
  ): Promise<BillingEstimate> {
    signal.throwIfAborted()
    const settings = await this.settings.read()
    signal.throwIfAborted()
    const empty: BillingEstimate = {
      sessionId,
      enabled: settings.enabled,
      supported: repository !== undefined,
      historyComplete: false,
      scannedEvents: 0,
      requests: 0,
      pricedRequests: 0,
      partialRequests: 0,
      unpricedRequests: 0,
      priceRevision: settings.revision,
      totals: [],
      breakdown: [],
      issueCounts: [],
      entries: [],
      detailsTruncated: false,
    }
    if (!settings.enabled || repository === undefined) return this.display(empty, currency, signal)
    const facts = new Map<number, BillingFact>()
    let before: number | undefined
    let scannedEvents = 0
    let coverage = true
    let complete = false
    for (let index = 0; index < 20 && scannedEvents < MAX_BILLING_EVENTS; index += 1) {
      signal.throwIfAborted()
      const page = await repository.readBillingPage(sessionId, before, signal)
      signal.throwIfAborted()
      if (page.eventCount < 0 || !Number.isSafeInteger(page.eventCount)) throw protocolError()
      // DSH limits messages per page, not intervening tool/turn events. The
      // accounting budget limits total work; exhausting it is partial coverage.
      if (page.eventCount > MAX_BILLING_EVENTS - scannedEvents) break
      scannedEvents += page.eventCount
      coverage &&= page.contiguous
      if (before !== undefined && page.toSequence !== before - 1) coverage = false
      for (const fact of page.facts) {
        const existing = facts.get(fact.sequence)
        if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(fact)) throw protocolError()
        facts.set(fact.sequence, fact)
      }
      if (!page.hasMore) {
        complete =
          coverage && (page.fromSequence === 0 || (scannedEvents === 0 && page.fromSequence === undefined))
        break
      }
      if (page.fromSequence === undefined || (before !== undefined && page.fromSequence >= before))
        throw protocolError()
      before = page.fromSequence
    }
    let currentRoute: BillingRoute | undefined
    // Route lookups run once per scanned fact (up to the event cap); nested
    // maps answer them without rebuilding a JSON composite key per fact.
    const prices: Map<string, Map<string, BillingPrice[]>> = new Map()
    const priceBucketFor = (providerId: string, modelId: string): BillingPrice[] => {
      let byModel = prices.get(providerId)
      if (byModel === undefined) {
        byModel = new Map()
        prices.set(providerId, byModel)
      }
      let bucket = byModel.get(modelId)
      if (bucket === undefined) {
        bucket = []
        byModel.set(modelId, bucket)
      }
      return bucket
    }
    const priceBucket = (providerId: string, modelId: string): readonly BillingPrice[] =>
      prices.get(providerId)?.get(modelId) ?? []
    for (const price of settings.prices) priceBucketFor(price.providerId, price.modelId).push(price)
    if (
      (settings.automatic !== false || (settings.mappings?.length ?? 0) > 0) &&
      this.automatic !== undefined
    ) {
      const routePositions = new Map<string, Map<string, number>>()
      const uniqueRoutes: BillingRoute[] = []
      for (const fact of facts.values())
        if (fact.route !== undefined && priceBucket(fact.route.providerId, fact.route.modelId).length === 0) {
          let byModel = routePositions.get(fact.route.providerId)
          if (byModel === undefined) {
            byModel = new Map()
            routePositions.set(fact.route.providerId, byModel)
          }
          const position = byModel.get(fact.route.modelId)
          if (position === undefined) {
            byModel.set(fact.route.modelId, uniqueRoutes.length)
            uniqueRoutes.push(fact.route)
          } else uniqueRoutes[position] = fact.route
        }
      // Match Map.set's first-insertion order and last-value replacement even
      // when routes from different providers are interleaved in the facts.
      for (const price of await this.automatic.resolve(uniqueRoutes, signal))
        if (priceBucket(price.providerId, price.modelId).length === 0)
          priceBucketFor(price.providerId, price.modelId).push(price)
      signal.throwIfAborted()
    }
    const entries = [...facts.values()]
      .sort((a, b) => a.sequence - b.sequence)
      .flatMap((fact) => {
        if (fact.kind === 'route') {
          currentRoute = fact.route
          return []
        }
        const route = fact.kind === 'attempt' ? (coverage ? currentRoute : undefined) : fact.route
        const candidates = route === undefined ? [] : [...priceBucket(route.providerId, route.modelId)]
        const applicable = candidates.filter(
          (price) =>
            (price.validFrom === undefined ||
              (fact.startedAt !== undefined && fact.startedAt >= price.validFrom)) &&
            (price.validUntil === undefined || (fact.time !== undefined && fact.time < price.validUntil)),
        )
        return [estimateBillingEntry(fact, route, applicable.length === 1 ? applicable[0] : candidates[0])]
      })
    const totals = new Map<string, string[]>()
    let pricedRequests = 0
    let partialRequests = 0
    for (const entry of entries) {
      if (entry.issues.length === 0) pricedRequests += 1
      else if (entry.amount !== undefined) partialRequests += 1
      if (entry.amount !== undefined && entry.currency !== undefined) {
        const values = totals.get(entry.currency) ?? []
        values.push(entry.amount)
        totals.set(entry.currency, values)
      }
    }
    return this.display(
      {
        ...empty,
        historyComplete: complete,
        scannedEvents,
        requests: entries.length,
        pricedRequests,
        partialRequests,
        unpricedRequests: entries.length - pricedRequests - partialRequests,
        totals: [...totals].map(([currency, values]) => ({ currency, amount: addBillingAmounts(values) })),
        ...summarizeBillingEntries(entries),
        entries: entries.slice(-100).reverse(),
        detailsTruncated: entries.length > 100,
      },
      currency,
      signal,
    )
  }

  private async display(
    result: BillingEstimate,
    currency: BillingDisplayCurrency | undefined,
    signal: AbortSignal,
  ): Promise<BillingEstimate> {
    if (currency === undefined) return result
    const fallback = billingCurrencyDisplay(result, currency)
    if (
      fallback.status === 'native' ||
      this.exchange === undefined ||
      result.totals.some((total) => total.currency !== 'USD' && total.currency !== 'CNY')
    )
      return { ...result, display: fallback }
    try {
      const exchange = await this.exchange.read(signal)
      signal.throwIfAborted()
      return { ...result, display: billingCurrencyDisplay(result, currency, exchange) }
    } catch {
      signal.throwIfAborted()
      return { ...result, display: fallback }
    }
  }
}

function protocolError(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'Invalid accounting history coverage.',
    retryable: false,
  })
}
