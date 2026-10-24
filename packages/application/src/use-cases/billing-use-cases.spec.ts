import { describe, expect, it } from 'vitest'
import type { BillingSettings, BillingUsageRepository } from '@dsh-vscode/domain'
import { BillingUseCases } from './billing-use-cases.js'

const route = { providerId: 'p', modelId: 'a' }
const settings: BillingSettings = {
  enabled: true,
  revision: 1,
  prices: [
    { ...route, currency: 'USD', input: '1', output: '2' },
    { providerId: 'p', modelId: 'b', currency: 'CNY', input: '3', output: '4' },
  ],
}
const signal = (): AbortSignal => new AbortController().signal
const useCases = new BillingUseCases({
  read: () => Promise.resolve(settings),
  save: () => Promise.resolve(settings),
})
const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 }

describe('billing history use case', () => {
  it('selects historical manual price periods and leaves uncovered requests unpriced', async () => {
    const split = Date.parse('2026-10-01T00:00:00Z')
    const settings: BillingSettings = {
      enabled: true,
      revision: 2,
      prices: [
        { ...route, currency: 'USD', input: '1', output: '2', validFrom: split - 2000, validUntil: split },
        { ...route, currency: 'USD', input: '3', output: '4', validFrom: split },
      ],
    }
    const useCases = new BillingUseCases({
      read: () => Promise.resolve(settings),
      save: () => Promise.resolve(settings),
    })
    const result = await useCases.estimate(
      's',
      {
        readBillingPage: () =>
          Promise.resolve({
            facts: [
              { kind: 'message', sequence: 0, route, usage, startedAt: split - 1000, time: split - 999 },
              { kind: 'message', sequence: 1, route, usage, startedAt: split, time: split + 1 },
              { kind: 'message', sequence: 2, route, usage, startedAt: split - 3000, time: split - 2999 },
            ],
            eventCount: 3,
            contiguous: true,
            hasMore: false,
            fromSequence: 0,
            toSequence: 2,
          }),
      },
      signal(),
    )
    expect(result.totals).toEqual([{ currency: 'USD', amount: '0.000052' }])
    expect([result.pricedRequests, result.unpricedRequests]).toEqual([2, 1])
    expect(result.entries[0]?.issues).toContain('unknown-price-period')
  })
  it('uses actual routes and header-scoped retries across pages, independent of transcript visibility', async () => {
    const repository: BillingUsageRepository = {
      readBillingPage: (_id, before) =>
        Promise.resolve(
          before === undefined
            ? {
                facts: [
                  { kind: 'attempt', sequence: 2, usage },
                  { kind: 'message', sequence: 3, route: { providerId: 'p', modelId: 'b' }, usage },
                ],
                eventCount: 2,
                contiguous: true,
                hasMore: true,
                fromSequence: 2,
                toSequence: 3,
              }
            : {
                facts: [
                  { kind: 'route', sequence: 0, route },
                  { kind: 'attempt', sequence: 1, usage },
                ],
                eventCount: 2,
                contiguous: true,
                hasMore: false,
                fromSequence: 0,
                toSequence: 1,
              },
        ),
    }
    const result = await useCases.estimate('s', repository, signal())
    expect(result).toMatchObject({
      requests: 3,
      pricedRequests: 3,
      historyComplete: true,
      totals: [
        { currency: 'USD', amount: '0.000028' },
        { currency: 'CNY', amount: '0.000038' },
      ],
    })
    expect(await useCases.estimate('s', repository, signal())).toEqual(result)
  })
  it('does not call the backend when disabled or unsupported; propagates failures and cancellation', async () => {
    expect((await useCases.estimate('s', undefined, signal())).supported).toBe(false)
    const disabled = new BillingUseCases({
      read: () => Promise.resolve({ ...settings, enabled: false }),
      save: () => Promise.resolve(settings),
    })
    const failure = {
      readBillingPage: (): never => {
        throw new Error('read failed')
      },
    }
    expect((await disabled.estimate('s', failure, signal())).requests).toBe(0)
    await expect(useCases.estimate('s', failure, signal())).rejects.toThrow('read failed')
    const controller = new AbortController()
    controller.abort()
    await expect(useCases.estimate('s', failure, controller.signal)).rejects.toThrow()
  })
  it('reports incomplete coverage and unknown usage instead of a complete zero bill', async () => {
    const result = await useCases.estimate(
      's',
      {
        readBillingPage: () =>
          Promise.resolve({
            facts: [{ kind: 'attempt', sequence: 5 }],
            eventCount: 1,
            contiguous: true,
            hasMore: false,
            fromSequence: 5,
            toSequence: 5,
          }),
      },
      signal(),
    )
    expect(result).toMatchObject({ historyComplete: false, requests: 1, unpricedRequests: 1, totals: [] })
    await expect(
      useCases.estimate(
        's',
        {
          readBillingPage: () =>
            Promise.resolve({
              facts: [],
              eventCount: 0,
              contiguous: true,
              hasMore: true,
            }),
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
})
