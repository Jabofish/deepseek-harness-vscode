import { addBillingAmounts, type BillingCostBreakdown, type BillingEstimate } from './billing.js'

export type BillingDisplayCurrency = 'CNY' | 'USD'
export type BillingExchangeRate =
  | { readonly usdCny: string; readonly date: string; readonly fallback?: never }
  | { readonly usdCny: '6.8'; readonly fallback: true; readonly date?: never }
export const DEFAULT_BILLING_EXCHANGE_RATE: BillingExchangeRate = { usdCny: '6.8', fallback: true }
export interface BillingCurrencyDisplay {
  readonly currency: BillingDisplayCurrency
  readonly status: 'native' | 'converted' | 'unavailable'
  readonly exchange?: BillingExchangeRate
  readonly totals: BillingEstimate['totals']
  readonly breakdown: BillingEstimate['breakdown']
}

const scale = 10n ** 15n
function units(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.')
  return BigInt(whole) * scale + BigInt(fraction.padEnd(15, '0'))
}
function decimal(value: bigint): string {
  const fraction = (value % scale).toString().padStart(15, '0').replace(/0+$/u, '')
  return `${value / scale}${fraction === '' ? '' : `.${fraction}`}`
}
/** Currency conversion changes the presentation only; all original charges remain untouched. */
export function billingCurrencyDisplay(
  estimate: Pick<BillingEstimate, 'totals' | 'breakdown'>,
  target: BillingDisplayCurrency,
  exchange: BillingExchangeRate = DEFAULT_BILLING_EXCHANGE_RATE,
): BillingCurrencyDisplay {
  const original = { currency: target, totals: estimate.totals, breakdown: estimate.breakdown }
  if (estimate.totals.every((total) => total.currency === target)) return { ...original, status: 'native' }
  if (
    !/^(0|[1-9]\d{0,8})(\.\d{1,9})?$/u.test(exchange.usdCny) ||
    units(exchange.usdCny) === 0n ||
    estimate.totals.some((total) => total.currency !== 'USD' && total.currency !== 'CNY')
  )
    return { ...original, status: 'unavailable' }
  const rate = units(exchange.usdCny)
  const convert = (amount: string, from: string): string => {
    if (from === target) return amount
    const numerator = units(amount) * (target === 'CNY' ? rate : scale)
    const denominator = target === 'CNY' ? scale : rate
    return decimal((numerator + denominator / 2n) / denominator)
  }
  const groups = new Map<string, BillingCostBreakdown>()
  for (const group of estimate.breakdown) {
    const previous = groups.get(group.category)
    const rates = new Map((previous?.rates ?? []).map((item) => [item.rate, item]))
    let ratesTruncated = group.ratesTruncated || previous?.ratesTruncated === true
    for (const item of group.rates) {
      const key = convert(item.rate, group.currency)
      const current = rates.get(key)
      if (current === undefined && rates.size === 32) {
        ratesTruncated = true
        continue
      }
      rates.set(key, {
        rate: key,
        tokens: String(BigInt(item.tokens) + BigInt(current?.tokens ?? '0')),
        amount: addBillingAmounts([current?.amount ?? '0', convert(item.amount, group.currency)]),
      })
    }
    groups.set(group.category, {
      category: group.category,
      currency: target,
      tokens: String(BigInt(group.tokens) + BigInt(previous?.tokens ?? '0')),
      amount: addBillingAmounts([previous?.amount ?? '0', convert(group.amount, group.currency)]),
      rates: [...rates.values()],
      ratesTruncated,
    })
  }
  return {
    currency: target,
    status: 'converted',
    exchange,
    totals: [
      {
        currency: target,
        amount: addBillingAmounts(estimate.totals.map((total) => convert(total.amount, total.currency))),
      },
    ],
    breakdown: [...groups.values()],
  }
}
