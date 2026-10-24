import { describe, expect, it } from 'vitest'
import { addBillingAmounts, estimateBillingEntry, isBillingRate, type BillingPrice } from './billing.js'

const route = { providerId: 'fixture-provider', modelId: 'fixture-model' }
const price: BillingPrice = {
  ...route,
  currency: 'USD',
  input: '2',
  output: '10',
  cacheRead: '0.2',
  cacheWrite: '2.5',
}
const usage = { inputTokens: 1200, outputTokens: 400, cacheReadTokens: 800, cacheWriteTokens: 100 }
const estimate = (
  patch: Partial<typeof usage> & { totalTokens?: number; reasoningTokens?: number } = {},
  p = price,
): ReturnType<typeof estimateBillingEntry> =>
  estimateBillingEntry({ kind: 'message', sequence: 1, usage: { ...usage, ...patch } }, route, p)

describe('independent billing rules', () => {
  it('prices disjoint buckets exactly and replaces reasoning within output', () => {
    expect(estimate().amount).toBe('0.00681')
    expect(estimate({ reasoningTokens: 60 }).amount).toBe('0.00681')
    expect(estimate({ reasoningTokens: 60 }, { ...price, reasoning: '15' }).amount).toBe('0.00711')
    expect(estimate({}, { ...price, reasoning: '15' }).issues).toContain('unknown-reasoning')
  })
  it('preserves unknown cache buckets, using only an authoritative total to derive zero', () => {
    const fact = { kind: 'attempt' as const, sequence: 2, usage: { inputTokens: 10, outputTokens: 2 } }
    expect(estimateBillingEntry(fact, route, price).issues).toEqual(['unknown-cache'])
    expect(
      estimateBillingEntry({ ...fact, usage: { ...fact.usage, totalTokens: 12 } }, route, price).issues,
    ).toEqual([])
    expect(
      estimateBillingEntry({ ...fact, usage: { ...fact.usage, totalTokens: 22 } }, route, price).issues,
    ).toContain('unknown-cache')
  })
  it('rejects fractional, unsafe, inconsistent and overlapping counts', () => {
    for (const patch of [
      { inputTokens: 1.5 },
      { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
      { totalTokens: 10 },
      { totalTokens: 2501 },
      { reasoningTokens: 401 },
    ])
      expect(estimate(patch).issues).toEqual(['invalid-usage'])
  })
  it('distinguishes missing price, usage and route; zero rates are explicit free estimates', () => {
    expect(estimateBillingEntry({ kind: 'message', sequence: 1 }, route, price).issues).toEqual([
      'missing-usage',
    ])
    expect(estimateBillingEntry({ kind: 'message', sequence: 1, usage }, undefined, price).issues).toEqual([
      'missing-route',
    ])
    expect(
      estimateBillingEntry({ kind: 'message', sequence: 1, usage }, route, undefined).amount,
    ).toBeUndefined()
    expect(estimate({}, { ...price, input: '0', output: '0', cacheRead: '0', cacheWrite: '0' }).amount).toBe(
      '0',
    )
    expect(estimate({}, { ...route, currency: 'USD', input: '2', output: '10' }).issues).toEqual([
      'missing-price',
    ])
  })
  it('sums tiny charges before formatting without floating point loss', () => {
    const tiny = estimateBillingEntry(
      { kind: 'message', sequence: 1, usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } },
      route,
      { ...price, input: '0.003' },
    )
    expect(tiny.amount).toBe('0.000000003')
    expect(addBillingAmounts(Array<string>(1000).fill(tiny.amount!))).toBe('0.000003')
    expect(['-1', 'NaN', '1e3', '', '1.0000000001', '1000000000'].some(isBillingRate)).toBe(false)
  })
})
