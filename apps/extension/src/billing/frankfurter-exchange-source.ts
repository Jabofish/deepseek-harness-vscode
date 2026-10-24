import { AppError, isBillingRate, type BillingExchangeRate } from '@dsh-vscode/domain'
import type { BillingExchangeSource } from '@dsh-vscode/application'
import type { BillingStateStorage } from './billing-settings-store.js'

const SOURCE = 'https://api.frankfurter.dev/v2/rate/USD/CNY?providers=ECB'
const CACHE_KEY = 'dsh.billing.exchange.v1'
const DAY = 86_400_000
interface PendingExchange {
  readonly controller: AbortController
  readonly result: Promise<BillingExchangeRate>
  callers: number
}
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
  private pending: PendingExchange | undefined
  public constructor(
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
    private readonly storage?: BillingStateStorage,
  ) {
    try {
      const value = storage?.get(CACHE_KEY)
      if (typeof value !== 'object' || value === null || !('quote' in value) || !('fetchedAt' in value))
        return
      const quote = value.quote
      if (
        typeof quote !== 'object' ||
        quote === null ||
        !('usdCny' in quote) ||
        !('date' in quote) ||
        typeof quote.usdCny !== 'string' ||
        !isBillingRate(quote.usdCny) ||
        Number(quote.usdCny) <= 0 ||
        typeof quote.date !== 'string' ||
        !validDate(quote.date) ||
        typeof value.fetchedAt !== 'number' ||
        !Number.isFinite(value.fetchedAt) ||
        value.fetchedAt > now() ||
        Date.parse(quote.date) > value.fetchedAt
      )
        return
      this.cached = { quote: { usdCny: quote.usdCny, date: quote.date }, expires: value.fetchedAt + DAY }
    } catch {
      // An unreadable local cache must not prevent a live quote or the default rate.
    }
  }

  public async read(signal: AbortSignal): Promise<BillingExchangeRate> {
    signal.throwIfAborted()
    if (this.cached !== undefined && this.cached.expires > this.now()) return this.cached.quote
    if (this.retryAfter > this.now()) {
      if (this.cached !== undefined) return this.cached.quote
      throw unavailable()
    }
    const pending =
      this.pending ??
      (() => {
        const controller = new AbortController()
        return { controller, result: this.refresh(controller.signal), callers: 0 }
      })()
    this.pending = pending
    pending.callers += 1
    try {
      const quote = await new Promise<BillingExchangeRate>((resolve, reject) => {
        const abort = (): void => reject(signal.reason instanceof Error ? signal.reason : unavailable())
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        void pending.result.then(
          (quote) => {
            signal.removeEventListener('abort', abort)
            resolve(quote)
          },
          (error: unknown) => {
            signal.removeEventListener('abort', abort)
            reject(error instanceof Error ? error : unavailable())
          },
        )
      })
      signal.throwIfAborted()
      return quote
    } catch {
      signal.throwIfAborted()
      if (this.cached !== undefined) return this.cached.quote
      throw unavailable()
    } finally {
      pending.callers -= 1
      if (pending.callers === 0 && this.pending === pending) {
        this.pending = undefined
        pending.controller.abort()
      }
    }
  }

  private async refresh(signal: AbortSignal): Promise<BillingExchangeRate> {
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
      const fetchedAt = this.now()
      this.cached = { quote, expires: fetchedAt + DAY }
      this.retryAfter = 0
      try {
        await this.storage?.update(CACHE_KEY, { quote, fetchedAt })
      } catch {
        // Keep the valid in-memory quote even if the local disk cannot be updated.
      }
      return quote
    } catch {
      signal.throwIfAborted()
      this.retryAfter = Math.max(this.retryAfter, this.now() + 60_000)
      throw unavailable()
    }
  }
}

function validDate(value: string): boolean {
  const time = Date.parse(value)
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value
  )
}
