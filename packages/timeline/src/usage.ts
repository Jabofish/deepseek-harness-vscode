import type { TokenUsage } from '@dsh-vscode/domain'

/** Add one completed step's accounting to the session aggregate. */
export function addTokenUsage(previous: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  return {
    inputTokens: safeCount(previous?.inputTokens) + safeCount(next.inputTokens),
    outputTokens: safeCount(previous?.outputTokens) + safeCount(next.outputTokens),
    cacheReadTokens: safeCount(previous?.cacheReadTokens) + safeCount(next.cacheReadTokens),
    cacheWriteTokens: safeCount(previous?.cacheWriteTokens) + safeCount(next.cacheWriteTokens),
    reasoningTokens: safeCount(previous?.reasoningTokens) + safeCount(next.reasoningTokens),
  }
}

/**
 * DSH Web UI's cache-hit definition: cached input divided by input that was
 * eligible to be either cached or uncached. Cache writes are a separate
 * accounting bucket; they are not cache misses and must not lower the hit
 * rate.
 */
export function cacheHitRate(usage: TokenUsage | undefined): number {
  const cacheReadTokens = safeCount(usage?.cacheReadTokens)
  const eligibleInputTokens = safeCount(usage?.inputTokens) + cacheReadTokens
  if (eligibleInputTokens === 0) return 0
  return cacheReadTokens / eligibleInputTokens
}

/**
 * Return the display-ready cache-hit percentage used by the official Web UI.
 *
 * DSH reports three disjoint prompt-side billing buckets.  Keeping the
 * calculation here, rather than rounding a floating-point ratio in React,
 * preserves near-full values such as 99.9% instead of incorrectly showing
 * 100% for a session with one uncached token.
 */
export function cacheHitPercent(usage: TokenUsage | undefined): string | null {
  if (usage === undefined) return null
  const cacheReadTokens = safeCount(usage.cacheReadTokens)
  const denominator = billedInputTokens(usage)
  if (denominator === 0) return null
  const missedInputTokens = safeCount(usage.inputTokens) + safeCount(usage.cacheWriteTokens)
  if (missedInputTokens === 0) return '100'

  const integerPercent = roundedIntegerPercent(cacheReadTokens, denominator)
  if (integerPercent < 100) return String(integerPercent)

  let decimalPlaces = 1
  let scaledDoubleGap = missedInputTokens * 200
  const denominatorTens = Math.floor(denominator / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    decimalPlaces += 1
  }
  const denominatorOnes = denominator % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor((factor * denominatorOnes) / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return `99.${'9'.repeat(decimalPlaces - 1)}${10 - roundedLoss}`
}

/** Sum DSH's disjoint prompt-side billing buckets. */
export function billedInputTokens(usage: TokenUsage): number {
  return safeCount(usage.inputTokens) + safeCount(usage.cacheReadTokens) + safeCount(usage.cacheWriteTokens)
}

/** Round a cache-read ratio to an integer percentage without float overflow. */
function roundedIntegerPercent(cacheReadTokens: number, denominator: number): number {
  const denominatorQuotient = Math.floor(denominator / 200)
  const denominatorRemainder = denominator % 200
  let lower = 0
  let upper = 100
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    const threshold = factor * denominatorQuotient + Math.ceil((factor * denominatorRemainder) / 200)
    if (cacheReadTokens >= threshold) lower = candidate
    else upper = candidate - 1
  }
  return lower
}

function safeCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
