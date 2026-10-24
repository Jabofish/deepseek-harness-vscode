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
  it('projects the requested currency, leaves native prices intact and degrades safely when exchange reads fail', async () => {
    let calls = 0
    let fail = false
    const scoped = new BillingUseCases(
      { read: () => Promise.resolve(settings), save: () => Promise.resolve(settings) },
      undefined,
      {
        read: () => {
          calls++
          return fail
            ? Promise.reject(new Error('NETWORK'))
            : Promise.resolve({ usdCny: '7', date: '2026-10-23' })
        },
      },
    )
    const repository: BillingUsageRepository = {
      readBillingPage: () =>
        Promise.resolve({
          facts: [{ kind: 'message', sequence: 0, route, usage }],
          eventCount: 1,
          contiguous: true,
          hasMore: false,
          fromSequence: 0,
          toSequence: 0,
        }),
    }
    const cny = await scoped.estimate('s', repository, signal(), 'CNY')
    expect(cny.totals).toEqual([{ currency: 'USD', amount: '0.000014' }])
    expect(cny.display).toMatchObject({
      currency: 'CNY',
      status: 'converted',
      totals: [{ currency: 'CNY', amount: '0.000098' }],
    })
    expect((await scoped.estimate('s', repository, signal(), 'USD')).display?.status).toBe('native')
    expect(calls).toBe(1)
    fail = true
    expect((await scoped.estimate('s', repository, signal(), 'CNY')).display).toMatchObject({
      status: 'converted',
      exchange: { usdCny: '6.8', fallback: true },
      totals: [{ currency: 'CNY', amount: '0.0000952' }],
    })
  })
  it('keeps cost breakdown and unpriced reasons from before the latest 100 request details', async () => {
    const result = await useCases.estimate(
      's',
      {
        readBillingPage: () =>
          Promise.resolve({
            facts: [
              { kind: 'route', sequence: 0, route },
              { kind: 'attempt', sequence: 1 },
              ...Array.from({ length: 101 }, (_, index) => ({
                kind: 'message' as const,
                sequence: index + 2,
                route,
                usage,
              })),
            ],
            eventCount: 103,
            contiguous: true,
            hasMore: false,
            fromSequence: 0,
            toSequence: 102,
          }),
      },
      signal(),
    )
    expect(result.entries).toHaveLength(100)
    expect(result.entries.some((entry) => entry.kind === 'attempt')).toBe(false)
    expect(result.issueCounts).toEqual([{ issue: 'missing-usage', count: 1, attempts: 1 }])
    expect(result.breakdown).toEqual([
      {
        category: 'input',
        currency: 'USD',
        tokens: '1010',
        amount: '0.00101',
        rates: [{ rate: '1', tokens: '1010', amount: '0.00101' }],
        ratesTruncated: false,
      },
      {
        category: 'output',
        currency: 'USD',
        tokens: '202',
        amount: '0.000404',
        rates: [{ rate: '2', tokens: '202', amount: '0.000404' }],
        ratesTruncated: false,
      },
    ])
    expect(result.totals).toEqual([{ currency: 'USD', amount: '0.001414' }])
  })
  it('prices a valid page containing more than 5000 raw events', async () => {
    const result = await useCases.estimate(
      's',
      {
        readBillingPage: () =>
          Promise.resolve({
            eventCount: 5001,
            contiguous: true,
            hasMore: false,
            fromSequence: 0,
            toSequence: 5000,
            facts: [{ kind: 'message', sequence: 5000, route, usage }],
          }),
      },
      signal(),
    )
    expect(result).toMatchObject({
      historyComplete: true,
      scannedEvents: 5001,
      requests: 1,
      pricedRequests: 1,
      totals: [{ currency: 'USD', amount: '0.000014' }],
    })
  })

  it.each([60_000, 100_000])(
    'keeps a partial estimate when the total event budget is reached after %i events',
    async (count) => {
      let calls = 0
      const result = await useCases.estimate(
        's',
        {
          readBillingPage: () =>
            Promise.resolve(
              ++calls === 1
                ? {
                    eventCount: count,
                    contiguous: true,
                    hasMore: true,
                    fromSequence: 60_000,
                    toSequence: 60_000 + count - 1,
                    facts: [{ kind: 'message', sequence: 60_000, route, usage }],
                  }
                : {
                    eventCount: 60_000,
                    contiguous: true,
                    hasMore: false,
                    fromSequence: 0,
                    toSequence: 59_999,
                    facts: [{ kind: 'message', sequence: 0, route, usage }],
                  },
            ),
        },
        signal(),
      )
      expect(result).toMatchObject({
        historyComplete: false,
        scannedEvents: count,
        requests: 1,
        pricedRequests: 1,
        totals: [{ currency: 'USD', amount: '0.000014' }],
      })
      expect(calls).toBe(count === 100_000 ? 1 : 2)
    },
  )

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
