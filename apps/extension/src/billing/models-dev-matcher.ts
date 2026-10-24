import { isBillingIdentifier, type BillingCandidate, type BillingRoute } from '@dsh-vscode/domain'
import { pricingCandidates } from 'llm-pricing'

/*! llm-pricing, MIT License, Copyright (c) 2026 Jannchie.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE. */

const object = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const normalized = (v: string): string =>
  v
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s._-]+/gu, '')
interface Entry extends BillingCandidate {
  readonly ids: readonly string[]
  readonly names: readonly string[]
}

/** Aliases come only from the catalog. Unknown resellers never inherit retail prices. */
export class ModelsDevCatalogIndex {
  private readonly entries: Entry[] = []
  private readonly providers = new Map<string, string[]>()
  private readonly providerIds = new Set<string>()
  public constructor(value: Record<string, unknown>) {
    for (const [providerId, raw] of Object.entries(value)) {
      if (!isBillingIdentifier(providerId)) continue
      const provider = object(raw)
      const models = object(provider?.models)
      if (models === undefined) continue
      this.providerIds.add(providerId)
      for (const name of new Set([
        providerId,
        typeof provider?.name === 'string' ? provider.name : providerId,
      ])) {
        const key = normalized(name)
        this.providers.set(key, [...new Set([...(this.providers.get(key) ?? []), providerId])])
      }
      for (const [modelId, raw] of Object.entries(models)) {
        if (!isBillingIdentifier(modelId)) continue
        const model = object(raw)
        const canonical = typeof model?.canonical_id === 'string' ? model.canonical_id : modelId
        const label = typeof model?.name === 'string' ? model.name : modelId
        const ids = [modelId, canonical]
        if (canonical.startsWith(`${providerId}/`)) ids.push(canonical.slice(providerId.length + 1))
        this.entries.push({ providerId, modelId, label: label.slice(0, 512) || modelId, ids, names: [label] })
      }
    }
  }
  public match(
    route: BillingRoute,
    label?: string,
  ): { readonly selected?: BillingCandidate; readonly candidates: readonly BillingCandidate[] } {
    const providerIds = this.providerIds.has(route.providerId)
      ? [route.providerId]
      : (this.providers.get(normalized(route.providerId)) ?? [])
    const own = this.entries.filter((entry) => providerIds.includes(entry.providerId))
    const exact = own.filter((entry) => entry.modelId === route.modelId)
    const matches =
      exact.length > 0
        ? exact
        : own.filter((entry) => entry.ids.some((id) => normalized(id) === normalized(route.modelId)))
    const candidate = (entry: Entry): BillingCandidate => ({
      providerId: entry.providerId,
      modelId: entry.modelId,
      label: entry.label,
    })
    if (providerIds.length === 1 && matches.length === 1)
      return { selected: candidate(matches[0]!), candidates: [] }
    // Broad upstream heuristics are suggestions only: they never authorize a
    // different channel, snapshot, free tier or reasoning variant automatically.
    const hints = [route.modelId, ...(label === undefined ? [] : [label])]
      .flatMap(pricingCandidates)
      .map(normalized)
    const suggestions =
      matches.length > 0
        ? matches
        : (providerIds.length === 1 ? own : this.entries).filter((entry) =>
            [...entry.ids, ...entry.names].some((name) => hints.includes(normalized(name))),
          )
    return { candidates: suggestions.slice(0, 8).map(candidate) }
  }
}
