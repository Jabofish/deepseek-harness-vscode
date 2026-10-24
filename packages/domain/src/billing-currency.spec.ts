import { describe, expect, it } from 'vitest'
import { billingCurrencyDisplay } from './billing-currency.js'
import type { BillingEstimate } from './billing.js'

const original: Pick<BillingEstimate, 'totals' | 'breakdown'> = {
  totals: [
    { currency: 'USD', amount: '1' },
    { currency: 'CNY', amount: '7' },
  ],
  breakdown: [
    {
      category: 'input',
      currency: 'USD',
      tokens: '1000000',
      amount: '1',
      rates: [{ rate: '1', tokens: '1000000', amount: '1' }],
      ratesTruncated: false,
    },
    {
      category: 'input',
      currency: 'CNY',
      tokens: '1000000',
      amount: '7',
      rates: [{ rate: '7', tokens: '1000000', amount: '7' }],
      ratesTruncated: false,
    },
  ],
}
const exchange = { usdCny: '7', date: '2026-10-23' }
describe('billing display currency', () => {
  it('converts and merges mixed original currencies without altering any source amount or rate', () => {
    const before = JSON.stringify(original)
    const result = billingCurrencyDisplay(original, 'CNY', exchange)
    expect(result.totals).toEqual([{ currency: 'CNY', amount: '14' }])
    expect(result.breakdown).toEqual([
      {
        category: 'input',
        currency: 'CNY',
        tokens: '2000000',
        amount: '14',
        rates: [{ rate: '7', tokens: '2000000', amount: '14' }],
        ratesTruncated: false,
      },
    ])
    expect(billingCurrencyDisplay(original, 'USD', exchange).totals).toEqual([
      { currency: 'USD', amount: '2' },
    ])
    expect(JSON.stringify(original)).toBe(before)
  })
  it('retains tiny and large decimal values during multiplication and inverse conversion', () => {
    const cost = (currency: string, amount: string): typeof original => ({
      totals: [{ currency, amount }],
      breakdown: [],
    })
    expect(
      billingCurrencyDisplay(cost('USD', '0.000000003'), 'CNY', { ...exchange, usdCny: '7.1' }).totals[0]
        ?.amount,
    ).toBe('0.0000000213')
    expect(billingCurrencyDisplay(cost('CNY', '0.7'), 'USD', exchange).totals[0]?.amount).toBe('0.1')
    expect(billingCurrencyDisplay(cost('USD', '9007199254740993'), 'CNY', exchange).totals[0]?.amount).toBe(
      '63050394783186951',
    )
  })
  it('uses the native amount without a quote and keeps unsupported or failed conversions explicit', () => {
    expect(
      billingCurrencyDisplay({ totals: [{ currency: 'CNY', amount: '1' }], breakdown: [] }, 'CNY').status,
    ).toBe('native')
    expect(billingCurrencyDisplay(original, 'CNY')).toMatchObject({
      status: 'converted',
      exchange: { usdCny: '6.8', fallback: true },
      totals: [{ currency: 'CNY', amount: '13.8' }],
    })
    expect(
      billingCurrencyDisplay({ totals: [{ currency: 'CNY', amount: '6.8' }], breakdown: [] }, 'USD').totals,
    ).toEqual([{ currency: 'USD', amount: '1' }])
    for (const quote of [
      { ...exchange, usdCny: '0' },
      { ...exchange, usdCny: '-1' },
    ])
      expect(billingCurrencyDisplay(original, 'CNY', quote)).toMatchObject({
        status: 'unavailable',
        totals: original.totals,
      })
    expect(
      billingCurrencyDisplay({ totals: [{ currency: 'GBP', amount: '1' }], breakdown: [] }, 'USD', exchange)
        .status,
    ).toBe('unavailable')
  })
})
