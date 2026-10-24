import {
  AppError,
  isBillingCondition,
  isBillingRate,
  type BillingCondition,
  type BillingRoute,
  type BillingRateOverride,
  type BillingCategory,
} from '@dsh-vscode/domain'
import type {
  BillingMatch,
  BillingReference,
  BillingReferenceList,
  BillingReferenceSource,
} from '@dsh-vscode/application'
import { ModelsDevCatalogIndex } from './models-dev-matcher.js'

const SOURCE = 'https://models.dev/experimental/v2.0/api.json'
const MAX_BYTES = 16 * 1024 * 1024
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const only = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key))
const decimal = (value: unknown): string | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  const text = value.toFixed(9).replace(/\.?0+$/, '') || '0'
  if (Number(text) !== value) return undefined
  return isBillingRate(text) ? text : undefined
}
const empty = (value: unknown): boolean => value === undefined || (Array.isArray(value) && value.length === 0)

/** Fixed source, explicit reads, bounded lifetime/cache. No DSH or user data is sent. */
export class ModelsDevPriceSource implements BillingReferenceSource {
  private index: ModelsDevCatalogIndex | undefined
  private cached:
    | { readonly value: Record<string, unknown>; readonly fetchedAt: string; readonly expiresAt: number }
    | undefined
  public constructor(private readonly fetcher: typeof fetch = globalThis.fetch) {}

  private async catalog(signal: AbortSignal): Promise<NonNullable<ModelsDevPriceSource['cached']>> {
    signal.throwIfAborted()
    if (this.cached === undefined || this.cached.expiresAt < Date.now()) {
      const combined = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      try {
        const response = await this.fetcher(SOURCE, {
          signal: combined,
          redirect: 'error',
          credentials: 'omit',
          headers: { accept: 'application/json' },
        })
        if (
          !response.ok ||
          response.body === null ||
          !response.headers.get('content-type')?.includes('application/json')
        ) {
          await response.body?.cancel().catch(() => undefined)
          throw new Error('Invalid price source response')
        }
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          for (;;) {
            const result = await reader.read()
            if (result.done) break
            size += result.value.byteLength
            if (size > MAX_BYTES) throw new Error('Price source exceeds size limit')
            chunks.push(result.value)
          }
        } finally {
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
        combined.throwIfAborted()
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        const value = object(JSON.parse(new TextDecoder().decode(bytes)))
        if (value === undefined || Object.keys(value).length > 4096) throw new Error('Invalid price catalog')
        this.cached = {
          value,
          fetchedAt: new Date().toISOString(),
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        }
        this.index = new ModelsDevCatalogIndex(value)
      } catch {
        signal.throwIfAborted()
        throw new AppError({
          code: 'BACKEND_UNREACHABLE',
          message: 'The reference price catalog could not be read. Try again or configure prices manually.',
          retryable: true,
        })
      }
    }
    signal.throwIfAborted()
    return this.cached
  }
  public async read(providerId: string, modelId: string, signal: AbortSignal): Promise<BillingReference> {
    const catalog = await this.catalog(signal)
    const match = this.index!.match({ providerId, modelId }, undefined, false)
    return match.selected === undefined
      ? { status: 'missing', fetchedAt: catalog.fetchedAt }
      : readModelsDevPrice(
          catalog.value,
          match.selected.providerId,
          match.selected.modelId,
          catalog.fetchedAt,
        )
  }
  public async search(query: string, offset: number, signal: AbortSignal): Promise<BillingReferenceList> {
    const catalog = await this.catalog(signal)
    return { ...this.index!.search(query, offset), fetchedAt: catalog.fetchedAt }
  }
  public async match(route: BillingRoute, signal: AbortSignal, label?: string): Promise<BillingMatch> {
    const catalog = await this.catalog(signal)
    const match = this.index!.match(route, label)
    if (match.selected === undefined)
      return { status: 'missing', fetchedAt: catalog.fetchedAt, candidates: match.candidates }
    const result = readModelsDevPrice(
      catalog.value,
      match.selected.providerId,
      match.selected.modelId,
      catalog.fetchedAt,
    )
    return {
      ...result,
      reference: match.selected,
      candidates: [],
      ...(result.price === undefined
        ? {}
        : { price: { ...result.price, providerId: route.providerId, modelId: route.modelId } }),
    }
  }
}

/** Bounded translation from the source's predicate vocabulary to our domain. */
function condition(value: unknown, depth = 0): BillingCondition | undefined {
  const data = object(value)
  if (data === undefined || depth > 6 || Object.keys(data).length > 8) return undefined
  const parts: BillingCondition[] = []
  for (const [key, value] of Object.entries(data)) {
    if (key === 'all' || key === 'any') {
      if (!Array.isArray(value) || value.length === 0 || value.length > 16) return undefined
      const children = value.map((v) => condition(v, depth + 1))
      if (children.some((v) => v === undefined)) return undefined
      parts.push(
        key === 'all' ? { all: children as BillingCondition[] } : { any: children as BillingCondition[] },
      )
    } else if (key === 'not') {
      const child = condition(value, depth + 1)
      if (child === undefined) return undefined
      parts.push({ not: child })
    } else if (key === 'utc_hours') {
      const hours = object(value)
      const part = { utcHours: hours }
      if (!isBillingCondition(part)) return undefined
      parts.push(part)
    } else if (key === 'utc_days') {
      const days = object(value)
      if (days === undefined || !only(days, ['in']) || !Array.isArray(days.in)) return undefined
      const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
      const numbers = days.in.map((v) => (typeof v === 'string' ? names.indexOf(v) : -1))
      parts.push({ utcDays: numbers })
    } else if (key === 'holiday') {
      const holiday = object(value)
      if (holiday === undefined || !only(holiday, ['equals']) || typeof holiday.equals !== 'string')
        return undefined
      parts.push({ holiday: holiday.equals })
    } else if (key === 'context' || key === 'date' || key === 'service_tier') {
      const part = { [key === 'service_tier' ? 'serviceTier' : key]: value }
      if (!isBillingCondition(part)) return undefined
      parts.push(part)
    } else return undefined
  }
  const result = parts.length === 1 ? parts[0] : { all: parts }
  return isBillingCondition(result) ? result : undefined
}

/** Declines richer pricing rather than flattening time, tier, modality or TTL rules. */
export function readModelsDevPrice(
  value: Record<string, unknown>,
  providerId: string,
  modelId: string,
  fetchedAt: string,
): BillingReference {
  const findKey = (record: Record<string, unknown>, key: string): string | undefined => {
    if (Object.hasOwn(record, key)) return key
    const matches = Object.keys(record).filter((candidate) => candidate.toLowerCase() === key.toLowerCase())
    return matches.length === 1 ? matches[0] : undefined
  }
  const providerKey = findKey(value, providerId)
  const provider = providerKey === undefined ? undefined : object(value[providerKey])
  const models = object(provider?.models)
  const modelKey = models === undefined ? undefined : findKey(models, modelId)
  const model = models !== undefined && modelKey !== undefined ? object(models[modelKey]) : undefined
  if (model === undefined) return { status: 'missing', fetchedAt }
  const cost = object(model.cost)
  const text = object(cost?.text)
  const input = object(text?.input)
  const output = object(text?.output)
  const cache = object(input?.cache)
  const unsupported = (): BillingReference => ({ status: 'unsupported', fetchedAt })
  if (
    cost === undefined ||
    text === undefined ||
    input === undefined ||
    output === undefined ||
    !only(cost, ['text', 'multipliers']) ||
    !only(text, ['input', 'output']) ||
    !only(input, ['price', 'cache', 'overrides', 'unit']) ||
    (input.unit !== undefined && input.unit !== 'token') ||
    !only(output, ['price', 'reasoning', 'overrides', 'unit']) ||
    (output.unit !== undefined && output.unit !== 'token') ||
    (cache !== undefined && !only(cache, ['read', 'write']))
  )
    return unsupported()
  const ttlWrite = (value: unknown): boolean => {
    const values = object(value)
    return (
      values !== undefined &&
      Object.keys(values).length > 0 &&
      Object.entries(values).every(([key, value]) => /^\d+[smh]$/.test(key) && decimal(value) !== undefined)
    )
  }
  const overrides: BillingRateOverride[] = []
  for (const [part, category] of [
    [input, 'input'],
    [output, 'output'],
  ] as const) {
    if (empty(part.overrides)) continue
    if (!Array.isArray(part.overrides) || part.overrides.length > 16) return unsupported()
    for (const raw of part.overrides) {
      const rule = object(raw)
      const when = condition(rule?.when)
      if (
        rule === undefined ||
        when === undefined ||
        !only(rule, category === 'input' ? ['when', 'price', 'cache'] : ['when', 'price', 'reasoning'])
      )
        return unsupported()
      const rates: Partial<Record<BillingCategory, string>> = {}
      const unavailable: BillingCategory[] = []
      if (rule.price !== undefined) {
        const rate = decimal(rule.price)
        if (rate === undefined) return unsupported()
        rates[category] = rate
      }
      if (rule.reasoning !== undefined) {
        const rate = decimal(rule.reasoning)
        if (rate === undefined) return unsupported()
        rates.reasoning = rate
      }
      if (rule.cache !== undefined) {
        const cache = object(rule.cache)
        if (cache === undefined || !only(cache, ['read', 'write'])) return unsupported()
        for (const [key, name] of [
          ['read', 'cacheRead'],
          ['write', 'cacheWrite'],
        ] as const)
          if (cache[key] !== undefined) {
            const rate = decimal(cache[key])
            if (rate === undefined) {
              if (key !== 'write' || !ttlWrite(cache[key])) return unsupported()
              unavailable.push(name)
            } else rates[name] = rate
          }
      }
      overrides.push({ when, rates, ...(unavailable.length === 0 ? {} : { unavailable }) })
    }
  }
  const multipliers: { when: BillingCondition; factor: string }[] = []
  if (!empty(cost.multipliers)) {
    if (!Array.isArray(cost.multipliers) || cost.multipliers.length > 16) return unsupported()
    for (const raw of cost.multipliers) {
      const rule = object(raw)
      const when = condition(rule?.when)
      const factor = decimal(rule?.factor)
      if (rule === undefined || !only(rule, ['when', 'factor']) || when === undefined || factor === undefined)
        return unsupported()
      multipliers.push({ when, factor })
    }
  }
  const inputRate = decimal(input.price)
  const outputRate = decimal(output.price)
  const read = decimal(cache?.read)
  const write = decimal(cache?.write)
  const reasoning = decimal(output.reasoning)
  if (
    inputRate === undefined ||
    outputRate === undefined ||
    (input.cache !== undefined && cache === undefined) ||
    (cache?.read !== undefined && read === undefined) ||
    (cache?.write !== undefined && write === undefined && !ttlWrite(cache.write)) ||
    (output.reasoning !== undefined && reasoning === undefined)
  )
    return unsupported()
  return {
    status: 'found',
    fetchedAt,
    price: {
      providerId,
      modelId,
      currency: 'USD',
      input: inputRate,
      output: outputRate,
      ...(read === undefined ? {} : { cacheRead: read }),
      ...(write === undefined ? {} : { cacheWrite: write }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(multipliers.length === 0 ? {} : { multipliers }),
      ...(overrides.length === 0 ? {} : { overrides }),
    },
  }
}
