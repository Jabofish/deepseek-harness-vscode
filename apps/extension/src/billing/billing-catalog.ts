import type { BillingCatalogEntry, BillingRoute, BillingSettings, ModelDescriptor } from '@dsh-vscode/domain'
import type { BillingReferenceSource } from '@dsh-vscode/application'

export const billingRouteKey = (route: BillingRoute): string =>
  JSON.stringify([route.providerId, route.modelId])

/** Generated reference prices stay separate from durable user overrides/mappings. */
export class BillingCatalog {
  private unavailable = false
  public constructor(
    private readonly source: BillingReferenceSource,
    private readonly settings: BillingSettings,
    private readonly assertCurrent: () => void,
  ) {}

  public async entry(
    route: BillingRoute,
    signal: AbortSignal,
    label = route.modelId,
  ): Promise<BillingCatalogEntry> {
    this.assertCurrent()
    const ids = { providerId: route.providerId, modelId: route.modelId }
    const base = { ...ids, label: label.slice(0, 512) || route.modelId, candidates: [] }
    const manual = this.settings.prices.find((price) => billingRouteKey(price) === billingRouteKey(route))
    if (manual !== undefined) return { ...base, status: 'manual', price: manual }
    const mapping = this.settings.mappings?.find(
      (mapping) => billingRouteKey(mapping) === billingRouteKey(route),
    )
    if (this.settings.automatic === false && mapping === undefined) return { ...base, status: 'missing' }
    if (this.unavailable) return { ...base, status: 'unavailable' }
    try {
      const match =
        mapping === undefined
          ? await this.source.match?.(route, signal, label)
          : {
              ...(await this.source.read(mapping.referenceProviderId, mapping.referenceModelId, signal)),
              reference: {
                providerId: mapping.referenceProviderId,
                modelId: mapping.referenceModelId,
                label: mapping.referenceModelId,
              },
              candidates: [],
            }
      this.assertCurrent()
      if (match === undefined) return { ...base, status: 'missing' }
      const status =
        match.status === 'found'
          ? 'automatic'
          : match.status === 'unsupported'
            ? 'unsupported'
            : match.candidates.length > 0
              ? 'ambiguous'
              : 'missing'
      return {
        ...base,
        status,
        candidates: match.candidates,
        ...(match.reference === undefined ? {} : { reference: match.reference }),
        ...(match.price === undefined ? {} : { price: { ...match.price, ...ids } }),
      }
    } catch {
      signal.throwIfAborted()
      this.assertCurrent()
      this.unavailable = true
      return { ...base, status: 'unavailable' }
    }
  }

  public routes(models: readonly ModelDescriptor[]): readonly (BillingRoute & { label: string })[] {
    const routes = new Map<string, BillingRoute & { label: string }>()
    for (const model of models) {
      const route = { providerId: model.providerId, modelId: model.id, label: model.label }
      routes.set(billingRouteKey(route), route)
    }
    for (const price of this.settings.prices)
      if (!routes.has(billingRouteKey(price)))
        routes.set(billingRouteKey(price), {
          providerId: price.providerId,
          modelId: price.modelId,
          label: price.modelId,
        })
    return [...routes.values()].sort(
      (a, b) => a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId),
    )
  }
}
