import { AppError, isBillingRate, type BillingExchangeRate } from '@dsh-vscode/domain'
import type { BillingExchangeSource } from '@dsh-vscode/application'

const SOURCE = 'https://api.frankfurter.dev/v2/rate/USD/CNY?providers=ECB'
const unavailable = (): AppError =>
  new AppError({
    code: 'BACKEND_UNREACHABLE',
    message: 'The reference exchange rate could not be read.',
    retryable: true,
  })
/** Public reference quote only: no session, model, workspace or credential data leaves the Host. */
export class FrankfurterExchangeSource implements BillingExchangeSource {
  private cached: { readonly quote: BillingExchangeRate; readonly expires: number } | undefined
  private retryAfter = 0
  public constructor(
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  public async read(signal: AbortSignal): Promise<BillingExchangeRate> {
    signal.throwIfAborted()
    if (this.cached !== undefined && this.cached.expires > this.now()) return this.cached.quote
    if (this.retryAfter > this.now()) throw unavailable()
    try {
      const combined = AbortSignal.any([signal, AbortSignal.timeout(5000)])
      const response = await this.fetcher(SOURCE, {
        signal: combined,
        redirect: 'error',
        credentials: 'omit',
        headers: { accept: 'application/json' },
      })
      if (
        !response.ok ||
        response.body === null ||
        !response.headers.get('content-type')?.includes('application/json')
      ) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('Invalid exchange response')
      }
      const reader = response.body.getReader()
      let text = ''
      let bytes = 0
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 8192) throw new Error('Exchange response too large')
          text += decoder.decode(chunk.value, { stream: true })
        }
        text += decoder.decode()
      } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
      combined.throwIfAborted()
      const value: unknown = JSON.parse(text)
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('Invalid exchange quote')
      const data = value as Record<string, unknown>
      const date = typeof data.date === 'string' ? data.date : ''
      const time = Date.parse(date)
      const usdCny =
        typeof data.rate === 'number' && Number.isFinite(data.rate)
          ? data.rate.toFixed(9).replace(/\.?0+$/u, '')
          : ''
      if (
        data.base !== 'USD' ||
        data.quote !== 'CNY' ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
        !Number.isFinite(time) ||
        new Date(time).toISOString().slice(0, 10) !== date ||
        time > this.now() ||
        this.now() - time > 14 * 86_400_000 ||
        !isBillingRate(usdCny) ||
        Number(usdCny) <= 0 ||
        Number(usdCny) !== data.rate
      )
        throw new Error('Invalid exchange quote')
      const quote = { usdCny, date }
      this.cached = { quote, expires: this.now() + 24 * 60 * 60 * 1000 }
      this.retryAfter = 0
      return quote
    } catch {
      signal.throwIfAborted()
      this.retryAfter = Math.max(this.retryAfter, this.now() + 60_000)
      throw unavailable()
    }
  }
}
