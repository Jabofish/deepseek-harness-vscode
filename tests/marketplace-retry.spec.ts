import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const { isRetryableMarketplaceError, marketplaceRetryDelay } = createRequire(import.meta.url)(
  '../scripts/marketplace-retry.cjs',
) as {
  isRetryableMarketplaceError: (error: unknown) => boolean
  marketplaceRetryDelay: (error: unknown, attempt: number, now?: number) => number | undefined
}

describe('future Marketplace publishing retries', () => {
  it('recognizes the service concurrency response, including nested Error payloads', () => {
    const body = {
      message: "Request was blocked due to exceeding usage of resource 'Concurrency' in namespace 'VSID'.",
      typeName: 'Microsoft.TeamFoundation.Framework.Server.RequestBlockedException',
    }
    expect(isRetryableMarketplaceError(body)).toBe(true)
    expect(isRetryableMarketplaceError(Object.assign(new Error(), { statusCode: 429, result: body }))).toBe(
      true,
    )
    expect(isRetryableMarketplaceError({ response: { statusCode: 503 } })).toBe(true)
    expect(isRetryableMarketplaceError(new Error('VSCE_PAT is invalid: 401'))).toBe(false)
  })

  it('honors Retry-After and bounds retries when the service asks for a longer delay', () => {
    expect(marketplaceRetryDelay({ response: { headers: { 'retry-after': '75' } } }, 1)).toBe(75_000)
    const now = Date.UTC(2026, 9, 24)
    expect(
      marketplaceRetryDelay({ headers: { 'Retry-After': new Date(now + 90_000).toUTCString() } }, 1, now),
    ).toBe(90_000)
    expect(marketplaceRetryDelay({ headers: { 'retry-after': '600' } }, 1)).toBeUndefined()
    expect(marketplaceRetryDelay({}, 1)).toBe(30_000)
    expect(marketplaceRetryDelay({}, 2)).toBe(60_000)
    expect(marketplaceRetryDelay({ headers: { 'retry-after': 'invalid' } }, 1)).toBe(30_000)
  })
})
