import { describe, expect, it } from 'vitest'
import { billingConfigurationSchema, featureRequestSchema, billingEstimateResponseSchema } from './index.js'

describe('billing protocol limits', () => {
  it('allows disjoint historical prices but rejects overlaps and malformed conditions', () => {
    const price = { providerId: 'p', modelId: 'm', currency: 'USD', input: '1', output: '2' }
    const split = Date.parse('2026-10-01T00:00:00Z')
    expect(
      billingConfigurationSchema.safeParse({
        enabled: true,
        prices: [
          { ...price, validUntil: split },
          { ...price, validFrom: split },
        ],
      }).success,
    ).toBe(true)
    expect(
      billingConfigurationSchema.safeParse({ enabled: true, prices: [price, { ...price, validFrom: split }] })
        .success,
    ).toBe(false)
    expect(
      billingConfigurationSchema.safeParse({
        enabled: true,
        prices: [{ ...price, multipliers: [{ when: { utcHours: { gte: '25:00' } }, factor: '2' }] }],
      }).success,
    ).toBe(false)
  })
  it('bounds prices and rejects duplicate routes, wire metadata and executable formulas', () => {
    const price = { providerId: 'fixture', modelId: 'model', currency: 'USD', input: '0', output: '1.25' }
    expect(billingConfigurationSchema.safeParse({ enabled: true, prices: [price] }).success).toBe(true)
    for (const prices of [
      [price, price],
      [{ ...price, endpoint: 'https://private.invalid' }],
      [{ ...price, input: 'eval(1)' }],
      [{ ...price, input: '-1' }],
    ])
      expect(billingConfigurationSchema.safeParse({ enabled: true, prices }).success).toBe(false)
    expect(
      featureRequestSchema.safeParse({
        type: 'billing.reference.read',
        requestId: 'r',
        payload: { providerId: 'p', modelId: 'm', url: 'http://arbitrary.invalid' },
      }).success,
    ).toBe(false)
    expect(
      billingEstimateResponseSchema.safeParse({
        kind: 'billing.estimate',
        estimate: { endpoint: 'https://private.invalid' },
      }).success,
    ).toBe(false)
  })
})
