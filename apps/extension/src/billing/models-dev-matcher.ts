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
  readonly canonical?: string
  readonly fingerprint: string
  readonly official: boolean
}

function stable(value: unknown, depth = 0): string {
  if (depth > 12) return 'unsupported-depth'
  if (Array.isArray(value)) return `[${value.map((item) => stable(item, depth + 1)).join(',')}]`
  const record = object(value)
  return record === undefined
    ? (JSON.stringify(value) ?? '')
    : `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stable(record[key], depth + 1)}`)
        .join(',')}}`
}

/** Bounded typo matching is used for suggestions, never automatic repricing. */
function close(left: string, right: string): boolean {
  if (left.length < 8 || Math.abs(left.length - right.length) > 2) return false
  let row = Array.from({ length: right.length + 1 }, (_, i) => i)
  for (let i = 1; i <= left.length; i++) {
    const next = Array<number>(right.length + 1).fill(3)
    next[0] = i
    for (let j = Math.max(1, i - 2); j <= Math.min(right.length, i + 2); j++)
      next[j] = Math.min(next[j - 1]! + 1, row[j]! + 1, row[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1))
    if (Math.min(...next) > 2) return false
    row = next
  }
  return row[right.length]! <= 2
}

const candidate = (entry: Entry): BillingCandidate => ({
  providerId: entry.providerId,
  modelId: entry.modelId,
  label: entry.label,
  ...(entry.official ? { official: true } : {}),
})

/** Catalog identities and equivalent prices establish aliases; heuristics suggest only. */
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
        const canonical = typeof model?.canonical_id === 'string' ? model.canonical_id : undefined
        const label = typeof model?.name === 'string' ? model.name : modelId
        const ids = [
          modelId,
          ...(canonical === undefined ? [] : [canonical, canonical.slice(canonical.indexOf('/') + 1)]),
        ]
        const lab = canonical?.includes('/') ? canonical.split('/')[0] : model?.family
        const baseProvider = providerId.replace(/-(?:cn|us|eu|global|international)$/iu, '')
        const official = typeof lab === 'string' && normalized(lab) === normalized(baseProvider)
        this.entries.push({
          providerId,
          modelId,
          label: label.slice(0, 512) || modelId,
          ids,
          names: [label],
          official,
          ...(canonical === undefined ? {} : { canonical }),
          fingerprint: stable(model?.cost),
        })
      }
    }
  }
  public match(
    route: BillingRoute,
    label?: string,
    officialFallback = true,
  ): { readonly selected?: BillingCandidate; readonly candidates: readonly BillingCandidate[] } {
    // Operational suffixes are aliases, not different price channels. An exact
    // catalog provider always wins, including an explicitly selected reseller.
    const alias = route.providerId.replace(/(?:[-_.\s]+(?:official|account))+$/iu, '')
    const providerIds = this.providerIds.has(route.providerId)
      ? [route.providerId]
      : (this.providers.get(normalized(route.providerId)) ?? this.providers.get(normalized(alias)) ?? [])
    const own = this.entries.filter((entry) => providerIds.includes(entry.providerId))
    const score = (entry: Entry): number => {
      if (entry.modelId === route.modelId) return 0
      if (entry.modelId.toLowerCase() === route.modelId.toLowerCase()) return 1
      if (entry.ids.some((id) => id.toLowerCase() === route.modelId.toLowerCase())) return 2
      if (entry.ids.some((id) => normalized(id) === normalized(route.modelId))) return 3
      if (/[:@]|(?:^|[-_])\d{8}(?:$|[-_])/u.test(route.modelId)) return 10
      if (
        entry.names.some(
          (name) =>
            normalized(name) === normalized(route.modelId) ||
            (label !== undefined && normalized(name) === normalized(label)),
        )
      )
        return 4
      return 10
    }
    const best = (entries: readonly Entry[]): Entry | undefined => {
      const rank = Math.min(...entries.map(score))
      return rank > 4 ? undefined : this.equivalent(entries.filter((entry) => score(entry) === rank))[0]
    }
    if (providerIds.length === 1) {
      const selected = best(own)
      if (selected !== undefined) return { selected: candidate(selected), candidates: [] }
    } else if (
      providerIds.length === 0 &&
      officialFallback &&
      !/(?:^|[-_.\s])(?:proxy|reseller|gateway|router|relay|broker)(?:$|[-_.\s])/iu.test(route.providerId)
    ) {
      const selected = best(this.entries.filter((entry) => entry.official))
      if (selected !== undefined) return { selected: candidate(selected), candidates: [] }
    }
    const hints = [route.modelId, ...(label === undefined ? [] : [label])]
      .flatMap(pricingCandidates)
      .map(normalized)
    const suggestions = (providerIds.length > 0 ? own : this.entries)
      .filter(
        (entry) =>
          score(entry) <= 4 ||
          [...entry.ids, ...entry.names].some((name) =>
            hints.some((hint) => hint === normalized(name) || close(hint, normalized(name))),
          ),
      )
      .sort(
        (a, b) =>
          Number(b.official) - Number(a.official) ||
          score(a) - score(b) ||
          a.providerId.localeCompare(b.providerId) ||
          a.modelId.localeCompare(b.modelId),
      )
    return { candidates: this.equivalent(suggestions, false).slice(0, 8).map(candidate) }
  }

  public search(
    query: string,
    offset = 0,
  ): {
    readonly entries: readonly BillingCandidate[]
    readonly hasMore: boolean
    readonly nextOffset: number
  } {
    const terms = query.trim().split(/\s+/u).map(normalized).filter(Boolean)
    const texts = (entry: Entry): string[] => [entry.providerId, ...entry.ids, ...entry.names].map(normalized)
    const rank = (entry: Entry): number =>
      terms.filter((term) => !texts(entry).some((text) => text.includes(term))).length
    const entries = this.entries
      .filter((entry) =>
        terms.every((term) =>
          [entry.providerId, ...entry.ids, ...entry.names].some(
            (text) => normalized(text).includes(term) || close(term, normalized(text)),
          ),
        ),
      )
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          Number(b.official) - Number(a.official) ||
          a.providerId.localeCompare(b.providerId) ||
          a.modelId.localeCompare(b.modelId),
      )
    const unique = this.equivalent(entries, false)
    return {
      entries: unique.slice(offset, offset + 50).map(candidate),
      hasMore: offset + 50 < unique.length,
      nextOffset: Math.min(offset + 50, unique.length),
    }
  }

  private equivalent(entries: readonly Entry[], requireUnique = true): Entry[] {
    const groups = new Map<string, Entry[]>()
    for (const entry of entries) {
      const key = JSON.stringify([
        entry.providerId,
        entry.canonical?.toLowerCase() ?? entry.modelId,
        entry.fingerprint,
      ])
      groups.set(key, [...(groups.get(key) ?? []), entry])
    }
    if (requireUnique && groups.size !== 1) return []
    return [...groups.values()].map(
      (aliases) =>
        aliases.sort((a, b) => {
          const preferred = (entry: Entry): boolean =>
            entry.canonical !== undefined &&
            normalized(entry.label) === normalized(entry.canonical.slice(entry.canonical.indexOf('/') + 1))
          return (
            Number(preferred(b)) - Number(preferred(a)) ||
            a.modelId.length - b.modelId.length ||
            a.modelId.localeCompare(b.modelId)
          )
        })[0]!,
    )
  }
}
