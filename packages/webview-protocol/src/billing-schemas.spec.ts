import { describe, expect, it } from 'vitest'
import {
  billingConfigurationSchema,
  featureRequestSchema,
  billingEstimateResponseSchema,
  billingReferencesResponseSchema,
} from './index.js'

describe('billing protocol limits', () => {
  it('accepts requested display currencies and rejects unsupported currencies or rate endpoints', () => {
    const request = {
      type: 'billing.estimate',
      requestId: 'fx',
      payload: { sessionId: 's', currency: 'CNY' },
    }
    expect(featureRequestSchema.safeParse(request).success).toBe(true)
    expect(
      featureRequestSchema.safeParse({ ...request, payload: { sessionId: 's', currency: 'USD' } }).success,
    ).toBe(true)
    expect(
      featureRequestSchema.safeParse({ ...request, payload: { sessionId: 's', currency: 'EUR' } }).success,
    ).toBe(false)
    expect(
      featureRequestSchema.safeParse({
        ...request,
        payload: { ...request.payload, endpoint: 'https://private.invalid' },
      }).success,
    ).toBe(false)
  })
  it('accepts bounded billing breakdowns and rejects unsafe token totals or raw diagnostic fields', () => {
    const group = {
      category: 'input',
      currency: 'USD',
      tokens: '18014398509481982',
      amount: '0.2',
      rates: [{ rate: '1', tokens: '18014398509481982', amount: '0.2' }],
      ratesTruncated: false,
    }
    const estimate = {
      sessionId: 's',
      enabled: true,
      supported: true,
      historyComplete: true,
      scannedEvents: 1,
      requests: 1,
      pricedRequests: 0,
      partialRequests: 1,
      unpricedRequests: 0,
      priceRevision: 1,
      totals: [{ currency: 'USD', amount: '0.2' }],
      breakdown: [group],
      issueCounts: [{ issue: 'unknown-cache', count: 1, attempts: 0 }],
      entries: [],
      detailsTruncated: false,
    }
    expect(billingEstimateResponseSchema.safeParse({ kind: 'billing.estimate', estimate }).success).toBe(true)
    const display = {
      currency: 'CNY',
      status: 'converted',
      exchange: { usdCny: '6.8', fallback: true },
      totals: [{ currency: 'CNY', amount: '1.36' }],
      breakdown: [],
    }
    expect(
      billingEstimateResponseSchema.safeParse({
        kind: 'billing.estimate',
        estimate: { ...estimate, display },
      }).success,
    ).toBe(true)
    expect(
      billingEstimateResponseSchema.safeParse({
        kind: 'billing.estimate',
        estimate: { ...estimate, display: { ...display, exchange: { usdCny: '7', fallback: true } } },
      }).success,
    ).toBe(false)
    for (const breakdown of [
      [{ ...group, tokens: '-1' }],
      [{ ...group, tokens: '9'.repeat(25) }],
      [{ ...group, rates: Array(33).fill(group.rates[0]) }],
      [{ ...group, endpoint: 'https://private.invalid' }],
    ])
      expect(
        billingEstimateResponseSchema.safeParse({
          kind: 'billing.estimate',
          estimate: { ...estimate, breakdown },
        }).success,
      ).toBe(false)
    expect(
      billingEstimateResponseSchema.safeParse({
        kind: 'billing.estimate',
        estimate: {
          ...estimate,
          issueCounts: [{ issue: 'unknown-cache', count: 1, attempts: 0, body: 'private' }],
        },
      }).success,
    ).toBe(false)
  })
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
