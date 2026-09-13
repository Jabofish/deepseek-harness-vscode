import { describe, expect, it } from 'vitest'
import type { TokenUsage } from '@dsh-vscode/domain'

import { addTokenUsage, billedInputTokens, cacheHitPercent, cacheHitRate } from '../src/usage.js'

const usage = (inputTokens: number, cacheReadTokens: number, cacheWriteTokens: number): TokenUsage => ({
  inputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  outputTokens: 0,
  reasoningTokens: 0,
})

/** Decimal places rendered by the display string ('' means an integer). */
const decimalsOf = (display: string): number => {
  const dot = display.indexOf('.')
  return dot === -1 ? 0 : display.length - dot - 1
}

/**
 * The documented contract, restated without reusing the implementation's
 * integer technique: the shown value must be the ratio rounded at the shown
 * precision, it must never claim a completed cache, and it must use as few
 * decimal places as that allows.
 */
const assertDocumentedRounding = (rows: TokenUsage): void => {
  const input = Math.max(0, rows.inputTokens)
  const cacheRead = Math.max(0, rows.cacheReadTokens ?? 0)
  const cacheWrite = Math.max(0, rows.cacheWriteTokens ?? 0)
  const denominator = input + cacheRead + cacheWrite
  const display = cacheHitPercent(rows)

  if (denominator === 0) {
    expect(display).toBeNull()
    return
  }
  const missed = input + cacheWrite
  if (missed === 0) {
    expect(display).toBe('100')
    return
  }

  expect(display).not.toBeNull()
  const shown = Number(display)
  const ratio = (cacheRead / denominator) * 100
  const places = decimalsOf(display ?? '')
  const halfUnit = 0.5 / 10 ** places

  // A session with one uncached prompt token must never display 100.
  expect(shown).toBeLessThan(100)
  // Rounded at the shown precision...
  expect(Math.abs(shown - ratio)).toBeLessThanOrEqual(halfUnit + 1e-9)
  // ...and no coarser precision would have been representable without
  // rounding up to a completed cache.
  if (places > 0) {
    const coarser = Math.round(ratio * 10 ** (places - 1)) / 10 ** (places - 1)
    expect(coarser).toBeGreaterThanOrEqual(100)
  }
  expect(display).toMatch(places === 0 ? /^\d+$/ : /^\d+\.\d+$/)
}

describe('cache hit display', () => {
  it('never claims a completed cache while prompt tokens are uncached', () => {
    const cases: readonly TokenUsage[] = [
      usage(1, 999, 0),
      usage(1, 999_999, 0),
      usage(1, 0, 0),
      usage(0, 999, 1),
      usage(7, 12_345, 8),
      usage(1, 4_999, 0),
      usage(3, 9_997, 0),
    ]
    for (const rows of cases) {
      const display = cacheHitPercent(rows)
      expect(display, JSON.stringify(rows)).not.toBe('100')
      assertDocumentedRounding(rows)
    }
  })

  it('shows the precision the official Web UI needs for a near-full cache', () => {
    // One uncached token in a million: 99.9999, not 100 and not 99.9.
    expect(cacheHitPercent(usage(1, 999_999, 0))).toBe('99.9999')
    expect(cacheHitPercent(usage(1, 999_998, 0))).toBe('99.9999')
    // One uncached token in a thousand: 99.9.
    expect(cacheHitPercent(usage(1, 999, 0))).toBe('99.9')
    // One uncached token in two thousand rounds to 99.95 at two places.
    expect(cacheHitPercent(usage(1, 1_999, 0))).toBe('99.95')
  })

  it('rounds an incomplete cache at the precision it displays', () => {
    expect(cacheHitPercent(usage(1, 1, 0))).toBe('50')
    expect(cacheHitPercent(usage(1, 2, 0))).toBe('67')
    expect(cacheHitPercent(usage(3, 1, 0))).toBe('25')
    expect(cacheHitPercent(usage(2, 1, 0))).toBe('33')
    // Exactly 99.5% is still shown as a percentage, not as a completed cache.
    expect(cacheHitPercent(usage(1, 199, 0))).toBe('99.5')
  })

  it('counts cache writes as billing input but not as cache misses', () => {
    const rows = usage(0, 500, 500)
    expect(billedInputTokens(rows)).toBe(1_000)
    expect(cacheHitPercent(rows)).toBe('50')
    expect(cacheHitRate(rows)).toBe(1)
  })

  it('agrees with an independent reference across a swept grid', () => {
    for (let input = 0; input <= 6; input += 1)
      for (let cacheWrite = 0; cacheWrite <= 6; cacheWrite += 1)
        for (const cacheRead of [0, 1, 2, 3, 5, 8, 13, 21, 55, 89, 144, 233, 377, 610, 987, 1_599, 2_584])
          assertDocumentedRounding(usage(input, cacheRead, cacheWrite))
  })

  it('reports nothing for an empty or absent aggregate', () => {
    expect(cacheHitPercent(undefined)).toBeNull()
    expect(cacheHitPercent(usage(0, 0, 0))).toBeNull()
    expect(cacheHitRate(undefined)).toBe(0)
  })

  it('treats a malformed bucket as zero instead of poisoning the display', () => {
    const malformed = {
      inputTokens: Number.NaN,
      cacheReadTokens: -5,
      cacheWriteTokens: Number.POSITIVE_INFINITY,
      outputTokens: 3,
      reasoningTokens: 0,
    } as TokenUsage
    expect(billedInputTokens(malformed)).toBe(0)
    expect(cacheHitPercent(malformed)).toBeNull()
    expect(cacheHitRate(malformed)).toBe(0)
  })

  it('accumulates completed steps over the four disjoint buckets', () => {
    expect(addTokenUsage(undefined, usage(1, 2, 3))).toEqual({
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      reasoningTokens: 0,
    })
    expect(addTokenUsage(usage(1, 2, 3), usage(4, 5, 6))).toEqual({
      inputTokens: 5,
      outputTokens: 0,
      cacheReadTokens: 7,
      cacheWriteTokens: 9,
      reasoningTokens: 0,
    })
  })
})
