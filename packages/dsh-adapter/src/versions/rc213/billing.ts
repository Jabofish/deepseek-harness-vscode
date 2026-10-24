import {
  AppError,
  isBillingIdentifier,
  type BillingFact,
  type BillingRoute,
  type BillingUsagePage,
  type TokenUsage,
} from '@dsh-vscode/domain'
import { recordOrUndefined as record } from '../../repositories/shared/guards.js'
import { isReplacementSurfaceEvent } from '../rc6/canonical-events.js'

/** dsh-v0.2.1-rc.3 / 1f81c047fc48fa190a683e469daa699857e9afe8:
 * core/session/src/types.ts, llm/src/message.ts and llm/src/types.ts.
 * Only durable settlements and request-header routing survive this boundary.
 */
export function rc213BillingPage(events: readonly unknown[], hasMore: boolean): BillingUsagePage {
  const facts: BillingFact[] = []
  const sequences: number[] = []
  for (const row of events) {
    const envelope = record(row)
    const event = record(envelope?.event) ?? envelope
    const sequence = event?.seq
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0)
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: 'Invalid accounting event sequence.',
        retryable: false,
      })
    sequences.push(sequence)
    const type = event?.type
    const data = record(event?.data)
    if (type === 'request/header') {
      const route = readRoute(record(record(data?.header)?.config))
      facts.push({ kind: 'route', sequence, ...(route === undefined ? {} : { route }) })
    } else if (
      (type === 'assistant/message' || type === 'assistant/attempt') &&
      !isReplacementSurfaceEvent(type, event)
    ) {
      const route =
        type === 'assistant/message' ? readRoute(record(record(data?.message)?.source)) : undefined
      const declared = data?.usage
      const rawUsage = declared !== undefined ? declared : lastUsage(data?.stream)
      const usage = readUsage(rawUsage)
      const time = validTime(event?.time) ? event.time : undefined
      const startedAt = firstTime(data?.stream)
      facts.push({
        kind: type === 'assistant/message' ? 'message' : 'attempt',
        sequence,
        ...(time === undefined ? {} : { time }),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(route === undefined ? {} : { route }),
        ...(usage === undefined ? {} : { usage }),
        ...(rawUsage !== undefined && usage === undefined ? { invalidUsage: true as const } : {}),
      })
    }
  }
  const ordered = [...sequences].sort((a, b) => a - b)
  return {
    facts,
    hasMore,
    eventCount: events.length,
    contiguous: ordered.every((value, index) => index === 0 || value === ordered[index - 1]! + 1),
    ...(ordered[0] === undefined ? {} : { fromSequence: ordered[0] }),
    ...(ordered.at(-1) === undefined ? {} : { toSequence: ordered.at(-1)! }),
  }
}

function validTime(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
  )
}
function firstTime(stream: unknown): number | undefined {
  if (!Array.isArray(stream) || stream.length === 0) return undefined
  const first = record(stream[0])
  const time = first?.type === 'chunk' ? first.time : first?.time0
  return validTime(time) ? time : undefined
}

function readRoute(value: Record<string, unknown> | undefined): BillingRoute | undefined {
  const providerId = value?.provider
  const modelId = value?.model
  return isBillingIdentifier(providerId) && isBillingIdentifier(modelId) ? { providerId, modelId } : undefined
}

function lastUsage(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const item = record(value[index])
    const chunk = item?.type === 'chunk' ? record(item.chunk) : undefined
    if (chunk?.type === 'usage') return chunk.usage
  }
  return undefined
}

function readUsage(value: unknown): TokenUsage | undefined {
  const data = record(value)
  const inputTokens = data?.inputTokens
  const outputTokens = data?.outputTokens
  const valid = (count: unknown): count is number =>
    typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
  if (!valid(inputTokens) || !valid(outputTokens)) return undefined
  for (const key of ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'])
    if (data?.[key] !== undefined && !valid(data[key])) return undefined
  return {
    inputTokens,
    outputTokens,
    ...(data?.totalTokens === undefined ? {} : { totalTokens: data.totalTokens as number }),
    ...(data?.cacheReadTokens === undefined ? {} : { cacheReadTokens: data.cacheReadTokens as number }),
    ...(data?.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: data.cacheWriteTokens as number }),
    ...(data?.reasoningTokens === undefined ? {} : { reasoningTokens: data.reasoningTokens as number }),
  }
}
