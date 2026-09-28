import type { TokenUsage } from '@dsh-vscode/domain'

import type { TurnTokenUsage, TurnUsageTracking } from './nodes.js'

export function completeTurnUsage(tracking: TurnUsageTracking | undefined): TurnTokenUsage | undefined {
  if (
    tracking === undefined ||
    !tracking.turnStarted ||
    tracking.invalid ||
    tracking.active !== undefined ||
    tracking.attempts.length === 0
  )
    return undefined
  const attempts = tracking.attempts.map(normalizeUsageAttempt)
  if (attempts.some((attempt) => attempt === undefined)) return undefined
  const completeAttempts = attempts as readonly NormalizedUsageAttempt[]
  const inputTokens = safeTokenSum(completeAttempts.map((item) => item.inputTokens))
  const outputTokens = safeTokenSum(completeAttempts.map((item) => item.outputTokens))
  const totalTokens = safeTokenSum(completeAttempts.map((item) => item.totalTokens))
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) return undefined
  const cacheReadTokens = safeOptionalTokenSum(completeAttempts.map((item) => item.cacheReadTokens))
  const cacheWriteTokens = safeOptionalTokenSum(completeAttempts.map((item) => item.cacheWriteTokens))
  const reasoningTokens = safeOptionalTokenSum(completeAttempts.map((item) => item.reasoningTokens))
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

interface NormalizedUsageAttempt {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

function normalizeUsageAttempt(usage: TokenUsage): NormalizedUsageAttempt | undefined {
  const { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens } = usage
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) return undefined
  if (cacheReadTokens !== undefined && !isTokenCount(cacheReadTokens)) return undefined
  if (cacheWriteTokens !== undefined && !isTokenCount(cacheWriteTokens)) return undefined
  if (reasoningTokens !== undefined && (!isTokenCount(reasoningTokens) || reasoningTokens > outputTokens))
    return undefined
  const knownPrompt = safeTokenSum([
    inputTokens,
    ...(cacheReadTokens === undefined ? [] : [cacheReadTokens]),
    ...(cacheWriteTokens === undefined ? [] : [cacheWriteTokens]),
  ])
  if (knownPrompt === undefined) return undefined
  let exactTotal: number
  if (totalTokens !== undefined) {
    if (!isTokenCount(totalTokens)) return undefined
    const exactPrompt = totalTokens - outputTokens
    if (!isTokenCount(exactPrompt) || exactPrompt < knownPrompt) return undefined
    if (cacheReadTokens !== undefined && cacheWriteTokens !== undefined && exactPrompt !== knownPrompt)
      return undefined
    exactTotal = totalTokens
  } else {
    if (cacheReadTokens === undefined || cacheWriteTokens === undefined) return undefined
    const derivedTotal = safeTokenSum([knownPrompt, outputTokens])
    if (derivedTotal === undefined) return undefined
    exactTotal = derivedTotal
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: exactTotal,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

function isTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function safeTokenSum(values: readonly number[]): number | undefined {
  let total = 0
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) return undefined
    total += value
    if (!Number.isSafeInteger(total)) return undefined
  }
  return total
}

function safeOptionalTokenSum(values: readonly (number | undefined)[]): number | undefined {
  if (values.some((value) => value === undefined)) return undefined
  return safeTokenSum(values as readonly number[])
}
