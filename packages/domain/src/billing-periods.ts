import type { BillingCondition, BillingFact, BillingPrice } from './billing.js'
import { isBillingRate } from './billing.js'

// State Council, 2026 public holiday schedule, 2025-11-04:
// https://www.gov.cn/zhengce/content/202511/content_7047090.htm
// Coverage is deliberately finite; an unknown year/region is not a working day.
const cn2026 = [
  ['01-01', '01-03'],
  ['02-15', '02-23'],
  ['04-04', '04-06'],
  ['05-01', '05-05'],
  ['06-19', '06-21'],
  ['09-25', '09-27'],
  ['10-01', '10-07'],
] as const
type Truth = boolean | undefined
function every(values: readonly Truth[]): Truth {
  return values.includes(false) ? false : values.includes(undefined) ? undefined : true
}
export function billingConditionAt(
  condition: BillingCondition,
  time?: number,
  context?: number,
  serviceTier?: string,
): Truth {
  if ('all' in condition)
    return every(condition.all.map((value) => billingConditionAt(value, time, context, serviceTier)))
  if ('any' in condition) {
    const values = condition.any.map((value) => billingConditionAt(value, time, context, serviceTier))
    return values.includes(true) ? true : values.includes(undefined) ? undefined : false
  }
  if ('not' in condition) {
    const value = billingConditionAt(condition.not, time, context, serviceTier)
    return value === undefined ? undefined : !value
  }
  if ('serviceTier' in condition)
    return serviceTier === undefined ? undefined : serviceTier === condition.serviceTier.equals
  if ('context' in condition) {
    if (context === undefined) return undefined
    const c = condition.context
    return (
      (c.gt === undefined || context > c.gt) &&
      (c.gte === undefined || context >= c.gte) &&
      (c.lt === undefined || context < c.lt) &&
      (c.lte === undefined || context <= c.lte)
    )
  }
  if (time === undefined) return undefined
  const date = new Date(time)
  if (!Number.isFinite(date.getTime())) return undefined
  if ('date' in condition) {
    const day = date.toISOString().slice(0, 10)
    return (
      (condition.date.gte === undefined || day >= condition.date.gte) &&
      (condition.date.lt === undefined || day < condition.date.lt)
    )
  }
  if ('utcDays' in condition) return condition.utcDays.includes(date.getUTCDay())
  if ('holiday' in condition) {
    if (condition.holiday !== 'CN' || date.getUTCFullYear() !== 2026) return undefined
    const day = date.toISOString().slice(5, 10)
    return cn2026.some(([from, to]) => day >= from && day <= to)
  }
  const minute = date.toISOString().slice(11, 16)
  return (
    (condition.utcHours.gte === undefined || minute >= condition.utcHours.gte) &&
    (condition.utcHours.lt === undefined || minute < condition.utcHours.lt)
  )
}
const scale = 1_000_000_000n
function rateUnits(rate: string): bigint {
  const [whole = '0', fraction = ''] = rate.split('.')
  return BigInt(whole) * scale + BigInt(fraction.padEnd(9, '0'))
}
function effective(
  price: BillingPrice,
  time?: number,
  context?: number,
  serviceTier?: string,
): BillingPrice | undefined {
  if (
    (price.validFrom !== undefined && (time === undefined || time < price.validFrom)) ||
    (price.validUntil !== undefined && (time === undefined || time >= price.validUntil))
  )
    return undefined
  const selected: { -readonly [K in keyof BillingPrice]: BillingPrice[K] } = { ...price }
  for (const rule of price.overrides ?? []) {
    const match = billingConditionAt(rule.when, time, context, serviceTier)
    if (match === undefined) return undefined
    if (match) {
      Object.assign(selected, rule.rates)
      for (const key of rule.unavailable ?? []) {
        if (key === 'input' || key === 'output') return undefined
        delete selected[key]
      }
    }
  }
  let factor = scale
  for (const rule of price.multipliers ?? []) {
    const match = billingConditionAt(rule.when, time, context, serviceTier)
    if (match === undefined && rateUnits(rule.factor) !== scale) return undefined
    if (match) {
      const product = factor * rateUnits(rule.factor)
      if (product % scale !== 0n) return undefined
      factor = product / scale
    }
  }
  const rates: Record<string, string> = {}
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) {
    if (selected[key] === undefined) continue
    const product = rateUnits(selected[key]) * factor
    if (product % scale !== 0n) return undefined
    const units = product / scale
    const fraction = (units % scale).toString().padStart(9, '0').replace(/0+$/, '')
    const value = `${units / scale}${fraction === '' ? '' : `.${fraction}`}`
    if (!isBillingRate(value)) return undefined
    rates[key] = value
  }
  return { ...selected, ...rates }
}

/** A request spanning different prices cannot be allocated without provider timing. */
export function billingPriceForFact(
  price: BillingPrice,
  fact: Exclude<BillingFact, { kind: 'route' }>,
): BillingPrice | undefined {
  if (
    !price.multipliers?.length &&
    !price.overrides?.length &&
    price.validFrom === undefined &&
    price.validUntil === undefined
  )
    return price
  const usage = fact.usage
  const context =
    usage?.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined
      ? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
      : undefined
  const end = fact.time
  const start = fact.startedAt
  if (end === undefined || start === undefined) return effective(price, undefined, context, fact.serviceTier)
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    end - start > 86_400_000
  )
    return undefined
  const result = effective(price, start, context, fact.serviceTier)
  if (result === undefined) return undefined
  const same = (time: number): boolean => {
    const candidate = effective(price, time, context, fact.serviceTier)
    return (
      candidate !== undefined &&
      ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'].every(
        (key) => candidate[key as keyof BillingPrice] === result[key as keyof BillingPrice],
      )
    )
  }
  if (!same(end)) return undefined
  // Time rules are minute-aligned. Also catches changes that later reverse.
  for (let time = Math.floor(start / 60_000) * 60_000 + 60_000; time <= end; time += 60_000)
    if (!same(time)) return undefined
  for (const boundary of [price.validFrom, price.validUntil])
    if (boundary !== undefined && boundary > start && boundary <= end) return undefined
  return result
}
