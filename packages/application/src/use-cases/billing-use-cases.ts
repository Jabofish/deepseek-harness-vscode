import { AppError, addBillingAmounts, estimateBillingEntry } from '@dsh-vscode/domain'
import type {
  BillingEstimate,
  BillingFact,
  BillingPrice,
  BillingRoute,
  BillingUsageRepository,
} from '@dsh-vscode/domain'
import type { BillingPriceResolver, BillingSettingsPort } from '../ports/billing-ports.js'

const MAX_BILLING_EVENTS = 100_000

/** No chat state, VS Code, HTTP or DSH wire dependencies. Reprices the chosen scope explicitly. */
export class BillingUseCases {
  public constructor(
    private readonly settings: BillingSettingsPort,
    private readonly automatic?: BillingPriceResolver,
  ) {}

  public async estimate(
    sessionId: string,
    repository: BillingUsageRepository | undefined,
    signal: AbortSignal,
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
      entries: [],
      detailsTruncated: false,
    }
    if (!settings.enabled || repository === undefined) return empty
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
    const prices = new Map<string, BillingPrice[]>()
    for (const price of settings.prices) {
      const key = JSON.stringify([price.providerId, price.modelId])
      prices.set(key, [...(prices.get(key) ?? []), price])
    }
    if (settings.automatic !== false && this.automatic !== undefined) {
      const routes = new Map<string, BillingRoute>()
      for (const fact of facts.values())
        if (fact.route !== undefined) {
          const key = JSON.stringify([fact.route.providerId, fact.route.modelId])
          if (!prices.has(key)) routes.set(key, fact.route)
        }
      for (const price of await this.automatic.resolve([...routes.values()], signal)) {
        const key = JSON.stringify([price.providerId, price.modelId])
        if (!prices.has(key)) prices.set(key, [price])
      }
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
        const candidates =
          route === undefined ? [] : (prices.get(JSON.stringify([route.providerId, route.modelId])) ?? [])
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
    return {
      ...empty,
      historyComplete: complete,
      scannedEvents,
      requests: entries.length,
      pricedRequests,
      partialRequests,
      unpricedRequests: entries.length - pricedRequests - partialRequests,
      totals: [...totals].map(([currency, values]) => ({ currency, amount: addBillingAmounts(values) })),
      entries: entries.slice(-100).reverse(),
      detailsTruncated: entries.length > 100,
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
