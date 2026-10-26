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
  it('shows the precision the official Web UI needs for a near-full cache', () => {
    // One uncached token in a million: 99.9999, not 100 and not 99.9.
    expect(cacheHitPercent(usage(1, 999_999, 0))).toBe('99.9999')
    expect(cacheHitPercent(usage(1, 999_998, 0))).toBe('99.9999')
    // One uncached token in a thousand: 99.9.
    expect(cacheHitPercent(usage(1, 999, 0))).toBe('99.9')
    // One uncached token in two thousand rounds to 99.95 at two places.
    expect(cacheHitPercent(usage(1, 1_999, 0))).toBe('99.95')
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

  it(
    'agrees with an exact reference over every ratio up to a denominator of 300',
    { tags: ['stress'] },
    () => {
      // The integer technique inside the implementation replaces float division
      // with a binary search over thresholds. The sparse grid above can step over
      // an off-by-one threshold; this sweep visits every (cacheRead, denominator)
      // pair, so a wrong neighbour would surface immediately.
      //
      // The reference stays in integers on purpose: `(115 / 200) * 100` is
      // 57.49999999999999 in binary, so a float reference would call the correct
      // half-up answer of 58 a defect. Rounding x/y half-up is
      // floor((2x + y) / 2y) when x/y is a percentage over 100.
      for (let denominator = 1; denominator <= 300; denominator += 1)
        for (let cacheRead = 0; cacheRead <= denominator; cacheRead += 1) {
          const rows = usage(0, cacheRead, denominator - cacheRead)
          if (cacheRead === denominator) {
            expect(cacheHitPercent(rows)).toBe('100')
            continue
          }
          const exactPercent = Math.floor((cacheRead * 200 + denominator) / (2 * denominator))
          if (exactPercent < 100) expect(cacheHitPercent(rows)).toBe(String(exactPercent))
          else assertDocumentedRounding(rows)
        }
    },
  )

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
      totalTokens: 6,
    })
    const first = addTokenUsage(undefined, usage(1, 2, 3))
    expect(addTokenUsage(first, usage(4, 5, 6))).toEqual({
      inputTokens: 5,
      outputTokens: 0,
      cacheReadTokens: 7,
      cacheWriteTokens: 9,
      reasoningTokens: 0,
      totalTokens: 21,
    })
  })

  it('omits an aggregate exact total when any included sample lacks one', () => {
    const withExactTotal: TokenUsage = { inputTokens: 100, outputTokens: 10, totalTokens: 125 }
    const withoutExactTotal: TokenUsage = { inputTokens: 40, outputTokens: 15 }

    expect(addTokenUsage(withExactTotal, withoutExactTotal)).not.toHaveProperty('totalTokens')
    expect(addTokenUsage(withoutExactTotal, withExactTotal)).not.toHaveProperty('totalTokens')
  })
})
