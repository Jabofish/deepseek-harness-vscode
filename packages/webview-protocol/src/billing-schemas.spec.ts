import { describe, expect, it } from 'vitest'
import {
  billingConfigurationSchema,
  featureRequestSchema,
  billingEstimateResponseSchema,
  billingReferencesResponseSchema,
} from './index.js'

describe('billing protocol limits', () => {
  it('bounds reference search and rejects endpoints or credentials in its results', () => {
    const request = {
      type: 'billing.reference.search',
      requestId: 'search',
      payload: { query: 'minimax m3', offset: 50 },
    }
    expect(featureRequestSchema.safeParse(request).success).toBe(true)
    expect(featureRequestSchema.safeParse({ ...request, payload: { query: 'x'.repeat(129) } }).success).toBe(
      false,
    )
    expect(featureRequestSchema.safeParse({ ...request, payload: { query: '', offset: -1 } }).success).toBe(
      false,
    )
    const result = {
      kind: 'billing.references',
      fetchedAt: '2026-10-24T00:00:00.000Z',
      hasMore: false,
      nextOffset: 1,
      entries: [{ providerId: 'vendor', modelId: 'model', label: 'Model', official: true }],
    }
    expect(billingReferencesResponseSchema.safeParse(result).success).toBe(true)
    expect(
      billingReferencesResponseSchema.safeParse({
        ...result,
        entries: [{ ...result.entries[0], endpoint: 'https://private.invalid', apiKey: 'secret' }],
      }).success,
    ).toBe(false)
    expect(
      billingReferencesResponseSchema.safeParse({ ...result, entries: Array(51).fill(result.entries[0]) })
        .success,
    ).toBe(false)
  })
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
