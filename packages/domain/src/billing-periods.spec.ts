import { describe, expect, it } from 'vitest'
import { estimateBillingEntry, type BillingPrice, type BillingCondition } from './billing.js'

it('applies recorded service tiers and leaves an unrecorded tier unknown', () => {
  const route = { providerId: 'fixture', modelId: 'tiered' }
  const price: BillingPrice = {
    ...route,
    currency: 'USD',
    input: '1',
    output: '2',
    multipliers: [{ when: { serviceTier: { equals: 'priority' } }, factor: '1.5' }],
  }
  const fact = {
    kind: 'message' as const,
    sequence: 0,
    usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
  }
  expect(estimateBillingEntry({ ...fact, serviceTier: 'standard' }, route, price).amount).toBe('1')
  expect(estimateBillingEntry({ ...fact, serviceTier: 'priority' }, route, price).amount).toBe('1.5')
  expect(estimateBillingEntry(fact, route, price).issues).toEqual(['unknown-price-period'])
})
const route = { providerId: 'fixture', modelId: 'scheduled' }
const condition: BillingCondition = {
  all: [
    { utcDays: [1, 2, 3, 4, 5] },
    {
      any: [
        { all: [{ utcHours: { gte: '01:00' } }, { utcHours: { lt: '04:00' } }] },
        { all: [{ utcHours: { gte: '06:00' } }, { utcHours: { lt: '10:00' } }] },
      ],
    },
    { not: { holiday: 'CN' } },
  ],
}
const price: BillingPrice = {
  ...route,
  currency: 'USD',
  input: '0.66',
  output: '1.98',
  multipliers: [{ when: condition, factor: '2' }],
}
const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 }
const estimate = (from: string, to = from, p = price): ReturnType<typeof estimateBillingEntry> =>
  estimateBillingEntry(
    { kind: 'message', sequence: 1, route, usage, startedAt: Date.parse(from), time: Date.parse(to) },
    route,
    p,
  )
describe('conditional exact billing', () => {
  it('keeps missing timing, unknown holiday years and cross-boundary requests unpriced', () => {
    for (const result of [
      estimate('2027-01-04T02:00:00Z'),
      estimate('2026-10-22T03:59:59Z', '2026-10-22T04:00:01Z'),
      estimateBillingEntry({ kind: 'message', sequence: 1, usage }, route, price),
    ]) {
      expect(result.amount).toBeUndefined()
      expect(result.issues).toContain('unknown-price-period')
    }
  })
  it('applies whole-request context tiers including cache and reasoning replaces its output share', () => {
    const tiered: BillingPrice = {
      ...route,
      currency: 'USD',
      input: '1',
      output: '2',
      cacheRead: '0.1',
      overrides: [
        { when: { context: { gt: 200000 } }, rates: { input: '2', output: '4', cacheRead: '0.2' } },
      ],
    }
    const result = estimateBillingEntry(
      {
        kind: 'message',
        sequence: 1,
        usage: { inputTokens: 100000, cacheReadTokens: 100001, cacheWriteTokens: 0, outputTokens: 100 },
      },
      route,
      tiered,
    )
    expect(result.amount).toBe('0.2204002')
    expect(result.issues).toEqual([])
    expect(
      estimateBillingEntry(
        {
          kind: 'message',
          sequence: 1,
          usage: { inputTokens: 200000, outputTokens: 100, totalTokens: 200100 },
        },
        route,
        tiered,
      ).amount,
    ).toBe('0.2002')
  })
  it('uses date rules and exact decimal multipliers without rounding an unrepresentable price', () => {
    const dated = {
      ...price,
      multipliers: [{ when: { date: { gte: '2026-11-01' } } as BillingCondition, factor: '0.5' }],
    }
    expect(estimate('2026-10-31T23:59:59Z', undefined, dated).amount).toBe('2.64')
    expect(estimate('2026-11-01T00:00:00Z', undefined, dated).amount).toBe('1.32')
    expect(estimate('2026-11-01T00:00:00Z', undefined, { ...dated, input: '0.000000001' }).issues).toContain(
      'unknown-price-period',
    )
  })
})
