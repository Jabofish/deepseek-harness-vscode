import { describe, expect, it, vi } from 'vitest'
import { ModelsDevPriceSource, readModelsDevPrice } from './models-dev-price-source.js'

const fetchedAt = '2026-10-24T00:00:00.000Z'
const plain = {
  text: {
    input: { price: 0.1, cache: { read: 0.000000001, write: 0 } },
    output: { price: 0.5, reasoning: 0.5 },
  },
}
const catalog = (cost: unknown): Record<string, unknown> => ({ fixture: { models: { model: { cost } } } })
const read = (cost: unknown): ReturnType<typeof readModelsDevPrice> =>
  readModelsDevPrice(catalog(cost), 'fixture', 'model', fetchedAt)

describe('models.dev price source', () => {
  it('copies exact unconditional rates and rejects conditional or unknown semantics', () => {
    expect(read(plain)).toMatchObject({
      status: 'found',
      price: { currency: 'USD', input: '0.1', output: '0.5', cacheRead: '0.000000001', cacheWrite: '0' },
    })
    for (const cost of [
      { ...plain, multipliers: [{ factor: 2, when: { unknown: { gte: '01:00' } } }] },
      {
        text: {
          ...plain.text,
          input: { price: 0.1, overrides: [{ when: { unknown_tier: { equals: 'priority' } }, price: 0.2 }] },
        },
      },
      { ...plain, audio: {} },
      { ...plain, unknown_future_rule: {} },
      { text: { ...plain.text, output: { price: -1 } } },
      { text: { ...plain.text, input: { price: 0.0000000001 } } },
    ])
      expect(read(cost).status).toBe('unsupported')
    expect(readModelsDevPrice({}, 'fixture', 'model', fetchedAt).status).toBe('missing')
  })
  it('preserves MiniMax service-tier pricing and reads case variants instead of rejecting the model', async () => {
    const data = {
      'minimax-cn': {
        models: {
          'MiniMax-M3': {
            family: 'minimax',
            cost: {
              text: {
                input: {
                  price: 0.3137,
                  cache: { read: 0.0627 },
                  overrides: [{ when: { context: { gt: 512000 } }, price: 0.6275 }],
                },
                output: { price: 1.2549 },
              },
              multipliers: [{ when: { service_tier: { equals: 'priority' } }, factor: 1.5 }],
            },
          },
        },
      },
    }
    const source = new ModelsDevPriceSource(() =>
      Promise.resolve(
        new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }),
      ),
    )
    const result = await source.match(
      { providerId: 'MINIMAX-CN', modelId: 'minimax-m3' },
      new AbortController().signal,
    )
    expect(result).toMatchObject({
      status: 'found',
      price: {
        input: '0.3137',
        output: '1.2549',
        cacheRead: '0.0627',
        multipliers: [{ when: { serviceTier: { equals: 'priority' } }, factor: '1.5' }],
      },
    })
    expect((await source.read('minimax-cn', 'MINIMAX-M3', new AbortController().signal)).status).toBe('found')
    expect(readModelsDevPrice(data, 'MINIMAX-CN', 'minimax-m3', fetchedAt).status).toBe('found')
    expect((await source.search('minimax m3', 0, new AbortController().signal)).entries).toMatchObject([
      { providerId: 'minimax-cn', modelId: 'MiniMax-M3' },
    ])
  })
  it('preserves supported schedules and context tiers and leaves unknown cache TTL writes unpriced', () => {
    const result = read({
      text: {
        input: {
          price: 1,
          cache: { read: 0.1, write: { '5m': 1.25, '1h': 2 } },
          overrides: [{ when: { context: { gt: 200000 } }, price: 2, cache: { read: 0.2 } }],
        },
        output: { price: 4, overrides: [{ when: { context: { gt: 200000 } }, price: 8 }] },
      },
      multipliers: [
        {
          when: {
            utc_days: { in: ['mon'] },
            any: [
              { all: [{ utc_hours: { gte: '01:00' } }, { utc_hours: { lt: '04:00' } }] },
              { all: [{ utc_hours: { gte: '06:00' } }, { utc_hours: { lt: '10:00' } }] },
            ],
            not: { holiday: { equals: 'CN' } },
          },
          factor: 2,
        },
      ],
    })
    expect(result.status).toBe('found')
    expect(result.price?.cacheWrite).toBeUndefined()
    expect(result.price?.overrides).toHaveLength(2)
    expect(result.price?.multipliers).toHaveLength(1)
    expect(result.price?.multipliers?.[0]?.when).toEqual({
      all: [
        { utcDays: [1] },
        {
          any: [
            { all: [{ utcHours: { gte: '01:00' } }, { utcHours: { lt: '04:00' } }] },
            { all: [{ utcHours: { gte: '06:00' } }, { utcHours: { lt: '10:00' } }] },
          ],
        },
        { not: { holiday: 'CN' } },
      ],
    })
  })
  it('fetches only the fixed source without credentials or redirects, reusing its bounded cache', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify(catalog(plain)), { headers: { 'content-type': 'application/json' } }),
      )
    const source = new ModelsDevPriceSource(fetcher)
    expect((await source.read('fixture', 'model', new AbortController().signal)).status).toBe('found')
    await source.read('fixture', 'missing', new AbortController().signal)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]).toMatchObject([
      'https://models.dev/experimental/v2.0/api.json',
      { redirect: 'error', credentials: 'omit', headers: { accept: 'application/json' } },
    ])
    const aborted = new AbortController()
    aborted.abort()
    await expect(source.read('fixture', 'model', aborted.signal)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('cancels oversized streams and sanitizes malformed/transport failures', async () => {
    let cancelled = false
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1))
      },
      cancel() {
        cancelled = true
      },
    })
    const source = new ModelsDevPriceSource(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(stream, { headers: { 'content-type': 'application/json' } })),
    )
    await expect(source.read('fixture', 'model', new AbortController().signal)).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
    })
    expect(cancelled).toBe(true)
    const failed = new ModelsDevPriceSource(
      vi.fn<typeof fetch>().mockRejectedValue(new Error('PRIVATE_TOKEN_AND_BODY')),
    )
    await expect(failed.read('fixture', 'model', new AbortController().signal)).rejects.not.toThrow(
      'PRIVATE_TOKEN_AND_BODY',
    )
    const malformed = new ModelsDevPriceSource(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('{', { headers: { 'content-type': 'application/json' } })),
    )
    await expect(malformed.read('fixture', 'model', new AbortController().signal)).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
    })
  })
})
