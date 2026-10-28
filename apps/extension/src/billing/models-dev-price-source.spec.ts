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

  it('reads prices from the fixed source without credentials or redirects', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify(catalog(plain)), { headers: { 'content-type': 'application/json' } }),
      )
    const source = new ModelsDevPriceSource(fetcher)
    expect((await source.read('fixture', 'model', new AbortController().signal)).status).toBe('found')
    await source.read('fixture', 'missing', new AbortController().signal)
    expect(fetcher.mock.calls[0]).toMatchObject([
      'https://models.dev/experimental/v2.0/api.json',
      { redirect: 'error', credentials: 'omit', headers: { accept: 'application/json' } },
    ])
    const aborted = new AbortController()
    aborted.abort()
    await expect(source.read('fixture', 'model', aborted.signal)).rejects.toThrow()
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
