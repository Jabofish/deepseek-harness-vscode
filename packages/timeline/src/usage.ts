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

function safeCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
