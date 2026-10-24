import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrankfurterExchangeSource } from './frankfurter-exchange-source.js'

const today = Date.parse('2026-10-24T12:00:00Z')
const quote = { date: '2026-10-23', base: 'USD', quote: 'CNY', rate: 6.6702 }
afterEach(() => vi.restoreAllMocks())
describe('reference exchange source', () => {
  it('persists a successful quote and retains it across restarts and offline refreshes', async () => {
    let stored: unknown
    let now = today
    const storage = {
      get: (): unknown => stored,
      update: (_key: string, value: unknown): Promise<void> => {
        stored = value
        return Promise.resolve()
      },
    }
    const source = new FrankfurterExchangeSource(
      () => Promise.resolve(Response.json(quote)),
      () => now,
      storage,
    )
    const signal = new AbortController().signal
    const successful = await source.read(signal)
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error('OFFLINE'))
    const restarted = new FrankfurterExchangeSource(offline, () => now, storage)
    expect(await restarted.read(signal)).toEqual(successful)
    expect(offline).not.toHaveBeenCalled()
    now += 86_400_001
    expect(await restarted.read(signal)).toEqual(successful)
    expect(await restarted.read(signal)).toEqual(successful)
    expect(offline).toHaveBeenCalledOnce()
    now += 60_001
    offline.mockResolvedValueOnce(Response.json({ ...quote, date: '2026-10-24', rate: 6.9 }))
    expect(await restarted.read(signal)).toEqual({ usdCny: '6.9', date: '2026-10-24' })
    await expect(new FrankfurterExchangeSource(offline, () => now, storage).read(signal)).resolves.toEqual({
      usdCny: '6.9',
      date: '2026-10-24',
    })
  })

  it('shares a pending quote without letting one caller cancel another', async () => {
    let deliver: ((response: Response) => void) | undefined
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          deliver = resolve
        }),
    )
    const source = new FrankfurterExchangeSource(fetcher, () => today)
    const controller = new AbortController()
    const first = source.read(controller.signal)
    const second = source.read(new AbortController().signal)
    controller.abort(new Error('USER_CANCELLED'))
    await expect(first).rejects.toThrow('USER_CANCELLED')
    deliver?.(Response.json(quote))
    expect(await second).toEqual({ usdCny: '6.6702', date: '2026-10-23' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('ignores corrupt persisted data and tolerates failed cache writes', async () => {
    const source = new FrankfurterExchangeSource(
      () => Promise.resolve(Response.json(quote)),
      () => today,
      {
        get: () => ({ quote: { usdCny: '7', date: '2099-01-01' }, fetchedAt: today }),
        update: () => Promise.reject(new Error('DISK_FAILURE')),
      },
    )
    expect(await source.read(new AbortController().signal)).toEqual({ usdCny: '6.6702', date: '2026-10-23' })
  })

  it('reads one fixed anonymous ECB quote, caches it and refreshes after expiry', async () => {
    let now = today
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(Response.json(quote)))
    const source = new FrankfurterExchangeSource(fetcher, () => now)
    const signal = new AbortController().signal
    expect(await source.read(signal)).toEqual({ usdCny: '6.6702', date: '2026-10-23' })
    await source.read(signal)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.frankfurter.dev/v2/rate/USD/CNY?providers=ECB',
      expect.objectContaining({ redirect: 'error', credentials: 'omit' }),
    )
    now += 86_400_001
    await source.read(signal)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('backs off network failures without extending the cooldown on every caller', async () => {
    let now = today
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('PRIVATE_NETWORK'))
      .mockImplementation(() => Promise.resolve(Response.json(quote)))
    const source = new FrankfurterExchangeSource(fetcher, () => now)
    const signal = new AbortController().signal
    await expect(source.read(signal)).rejects.toMatchObject({ code: 'BACKEND_UNREACHABLE' })
    now += 30_000
    await expect(source.read(signal)).rejects.not.toThrow('PRIVATE_NETWORK')
    expect(fetcher).toHaveBeenCalledTimes(1)
    now += 30_001
    expect((await source.read(signal)).usdCny).toBe('6.6702')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each([
    { ...quote, rate: 0 },
    { ...quote, base: 'CNY' },
    { ...quote, date: '2026-10-25' },
    { ...quote, date: '2026-09-01' },
    { ...quote, rate: 0.1234567891 },
  ])('rejects malformed or stale quotes without publishing a fake rate', async (value) => {
    const source = new FrankfurterExchangeSource(
      () => Promise.resolve(Response.json(value)),
      () => today,
    )
    await expect(source.read(new AbortController().signal)).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
    })
  })
  it('bounds the response and preserves cancellation instead of caching a failed request', async () => {
    const oversized = new FrankfurterExchangeSource(
      () => Promise.resolve(Response.json({ ...quote, extra: 'x'.repeat(8192) })),
      () => today,
    )
    await expect(oversized.read(new AbortController().signal)).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
    })
    const controller = new AbortController()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })
        }),
    )
    const source = new FrankfurterExchangeSource(fetcher, () => today)
    const pending = source.read(controller.signal)
    controller.abort(new Error('USER_CANCELLED'))
    await expect(pending).rejects.toThrow('USER_CANCELLED')
    fetcher.mockResolvedValueOnce(Response.json(quote))
    await expect(source.read(new AbortController().signal)).resolves.toMatchObject({ usdCny: '6.6702' })
  })
  it('times out a hanging exchange read', async () => {
    const timeout = new AbortController()
    const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const source = new FrankfurterExchangeSource(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('Timeout')), { once: true })
        }),
      () => today,
    )
    const checked = expect(source.read(new AbortController().signal)).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
    })
    expect(timer).toHaveBeenCalledWith(5000)
    timeout.abort(new Error('TIMEOUT'))
    await checked
  })
})
