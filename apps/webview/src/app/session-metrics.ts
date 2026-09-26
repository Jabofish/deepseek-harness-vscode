import type { ContextPressure, SessionStatsProjection, TokenUsage } from '@dsh-vscode/domain'

export function readContextPressure(value: unknown, breakdownValue?: unknown): ContextPressure | undefined {
  const record = object(value)
  const pressureValid =
    record === undefined ||
    ((!Object.prototype.hasOwnProperty.call(record, 'pressureTokens') ||
      nonNegativeTokenCount(record.pressureTokens) !== undefined) &&
      (!Object.prototype.hasOwnProperty.call(record, 'projectedTokens') ||
        nonNegativeTokenCount(record.projectedTokens) !== undefined) &&
      (!Object.prototype.hasOwnProperty.call(record, 'contextWindow') ||
        positiveTokenCount(record.contextWindow) !== undefined))
  const pressureTokens = pressureValid ? nonNegativeTokenCount(record?.pressureTokens) : undefined
  const projectedTokens = pressureValid ? nonNegativeTokenCount(record?.projectedTokens) : undefined
  const contextWindow = pressureValid ? positiveTokenCount(record?.contextWindow) : undefined
  // DSH publishes these as two independent projections. Keep accepting the
  // nested shape used by early fixtures so rc.6/rc.7 deployments remain safe.
  const breakdown = readContextBreakdown(breakdownValue) ?? readContextBreakdown(record?.contextBreakdown)
  if (
    pressureTokens === undefined &&
    projectedTokens === undefined &&
    contextWindow === undefined &&
    breakdown === undefined
  )
    return undefined
  return {
    ...(pressureTokens === undefined ? {} : { pressureTokens }),
    ...(projectedTokens === undefined ? {} : { projectedTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(breakdown === undefined ? {} : { breakdown }),
  }
}

function readContextBreakdown(value: unknown): ContextPressure['breakdown'] | undefined {
  const record = object(value)
  if (record === undefined) return undefined
  const systemTokens = nonNegativeTokenCount(record.systemTokens)
  const toolsTokens = nonNegativeTokenCount(record.toolsTokens)
  const messageTokens = nonNegativeTokenCount(record.messageTokens)
  if (systemTokens === undefined || toolsTokens === undefined || messageTokens === undefined) return undefined
  return { systemTokens, toolsTokens, messageTokens }
}

export function readTokenUsageProjection(value: unknown): TokenUsage | undefined {
  const record = object(value)
  if (record === undefined) return undefined
  const inputTokens = nonNegativeTokenCount(record.uncachedInputTokens ?? record.inputTokens)
  const outputTokens = nonNegativeTokenCount(record.outputTokens)
  const hasDeclaredTotal = Object.hasOwn(record, 'totalTokens')
  const declaredTotal = exactNonNegativeTokenCount(record.totalTokens)
  const cacheReadTokens = nonNegativeTokenCount(record.cacheReadTokens)
  const cacheWriteTokens = nonNegativeTokenCount(record.cacheWriteTokens)
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    (hasDeclaredTotal && declaredTotal === undefined) ||
    (record.cacheReadTokens !== undefined && cacheReadTokens === undefined) ||
    (record.cacheWriteTokens !== undefined && cacheWriteTokens === undefined)
  )
    return undefined
  const totalTokens =
    declaredTotal ??
    (cacheReadTokens === undefined || cacheWriteTokens === undefined
      ? undefined
      : exactNonNegativeTokenSum([
          exactNonNegativeTokenCount(record.uncachedInputTokens ?? record.inputTokens),
          exactNonNegativeTokenCount(record.outputTokens),
          exactNonNegativeTokenCount(record.cacheReadTokens),
          exactNonNegativeTokenCount(record.cacheWriteTokens),
        ]))
  return {
    inputTokens,
    outputTokens,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  }
}

export function readSessionStatsProjection(value: unknown): SessionStatsProjection | undefined {
  const record = object(value)
  if (record === undefined) return undefined
  const turns = nonNegativeTokenCount(record.turns)
  const steps = nonNegativeTokenCount(record.steps)
  const ttftSteps = nonNegativeTokenCount(record.ttftSteps)
  const llmMs = nonNegativeMetric(record.llmMs)
  const toolMs = nonNegativeMetric(record.toolMs)
  const ttftMs = nonNegativeMetric(record.ttftMs)
  const decodeMs = nonNegativeMetric(record.decodeMs)
  const decodeTokens = nonNegativeMetric(record.decodeTokens)
  if (
    turns === undefined ||
    steps === undefined ||
    ttftSteps === undefined ||
    llmMs === undefined ||
    toolMs === undefined ||
    ttftMs === undefined ||
    decodeMs === undefined ||
    decodeTokens === undefined
  )
    return undefined
  return { turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function nonNegativeTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function exactNonNegativeTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function exactNonNegativeTokenSum(values: readonly (number | undefined)[]): number | undefined {
  let total = 0
  for (const value of values) {
    if (value === undefined) return undefined
    total += value
    if (!Number.isSafeInteger(total)) return undefined
  }
  return total
}

function nonNegativeMetric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function positiveTokenCount(value: unknown): number | undefined {
  const count = nonNegativeTokenCount(value)
  return count === undefined || count === 0 ? undefined : count
}
