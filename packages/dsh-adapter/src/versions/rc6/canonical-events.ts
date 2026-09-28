import { eventIndex, object, positiveSafeNumber, tokenCount } from './value-guards.js'
import { recordOrUndefined as objectOrUndefined } from '../../repositories/shared/guards.js'

const CANONICAL_SESSION_EVENT_NAMES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/chunk',
  'assistant/attempt',
  'assistant/message',
  'tool/call',
  'tool/result',
  'todo/write',
  'request/header',
  'request/context',
])

const SURFACE_SESSION_EVENT_NAMES = new Set(['user/message', 'assistant/message', 'tool/result'])

/**
 * Whether an event is a model-only surface replacement rather than an append.
 *
 * A `{ op: 'replace' }` marker means the node shadowed an earlier surface range
 * instead of entering the conversation at its own position: the surface fold
 * hides that range from the model-visible surface, and the copy restates it for
 * the model alone. A human transcript is built from append-origin events, so a
 * copy must never become a message the reader never wrote — a landed
 * compaction would otherwise show up as a user turn carrying the summary. Its
 * durable sequence still has to reach the client, so the row collapses to the
 * internal watermark marker instead of being dropped.
 */
export function isReplacementSurfaceEvent(name: string, value: unknown): boolean {
  if (!SURFACE_SESSION_EVENT_NAMES.has(name)) return false
  const envelope = objectOrUndefined(value)
  if (envelope === undefined) return false
  return [envelope.surfaceOp, objectOrUndefined(envelope.data)?.surfaceOp].some(
    (candidate) => objectOrUndefined(candidate)?.op === 'replace',
  )
}

/**
 * The pinned session-event carrier validates only the common envelope because
 * the event vocabulary is merge-extensible. Validate the fixed event payloads
 * at the adapter boundary before mapping them into timeline state; otherwise a
 * malformed known event can become a synthetic id, empty message, or generic
 * tool and look like durable user activity.
 */
export function assertCanonicalSessionEvent(name: string, value: unknown): void {
  if (!CANONICAL_SESSION_EVENT_NAMES.has(name)) return
  const envelope = objectOrUndefined(value)
  const data = objectOrUndefined(envelope?.data)
  if (data === undefined) throw new Error(`Malformed ${name} data`)
  switch (name) {
    case 'turn/start':
      assertCanonicalEventIndex(data.turn, `${name} turn`)
      return
    case 'turn/end':
      assertCanonicalEventIndex(data.turn, `${name} turn`)
      assertCanonicalTurnEndReason(data.reason, name)
      return
    case 'step/start':
    case 'step/end':
      assertCanonicalEventIndex(data.turn, `${name} turn`)
      assertCanonicalEventIndex(data.step, `${name} step`)
      return
    case 'user/message':
      assertCanonicalMessage(data, 'user/message')
      return
    case 'assistant/chunk':
      assertCanonicalEventIndex(data.turn, `${name} turn`)
      assertCanonicalEventIndex(data.step, `${name} step`)
      assertCanonicalStreamChunk(data.chunk)
      return
    case 'assistant/attempt':
      assertCanonicalEventIndex(data.turn, `${name} turn`)
      assertCanonicalEventIndex(data.step, `${name} step`)
      if (!Array.isArray(data.stream)) throw new Error(`Malformed ${name} stream`)
      return
    case 'assistant/message':
      assertCanonicalEventIndex(data.turn, `${name} turn`)
      assertCanonicalEventIndex(data.step, `${name} step`)
      assertCanonicalMessage(data.message, name)
      if (data.usage !== undefined) assertCanonicalTokenUsage(data.usage, `${name} usage`)
      return
    case 'tool/call':
      assertCanonicalEventIndex(data.turn, `${name} turn`)
      assertCanonicalEventIndex(data.step, `${name} step`)
      assertCanonicalNonEmptyString(data.callId, `${name} callId`)
      assertCanonicalString(data.name, `${name} name`)
      assertCanonicalString(data.arguments, `${name} arguments`)
      return
    case 'tool/result':
      assertCanonicalEventIndex(data.turn, `${name} turn`)
      assertCanonicalEventIndex(data.step, `${name} step`)
      assertCanonicalMessage(data.message, name)
      if (data.error !== undefined) {
        const error = objectOrUndefined(data.error)
        if (error === undefined) throw new Error(`Malformed ${name} error`)
        assertCanonicalString(error.name, `${name} error name`)
        assertCanonicalString(error.code, `${name} error code`)
      }
      return
    case 'todo/write':
      if (!Array.isArray(data.todos)) throw new Error(`Malformed ${name} todos`)
      return
    case 'request/header': {
      const header = object(data.header, `${name} header`)
      const config = object(header.config, `${name} config`)
      assertCanonicalNonEmptyString(config.provider, `${name} provider`)
      assertCanonicalNonEmptyString(config.model, `${name} model`)
      if (data.reason !== 'initial' && data.reason !== 'resume' && data.reason !== 'change')
        throw new Error(`Malformed ${name} reason`)
      return
    }
    case 'request/context':
      assertCanonicalNonEmptyString(data.provider, `${name} provider`)
      assertCanonicalNonEmptyString(data.model, `${name} model`)
      if (data.contextWindow !== undefined && !isFiniteNumber(data.contextWindow))
        throw new Error(`Malformed ${name} contextWindow`)
      return
  }
}

function assertCanonicalEventIndex(value: unknown, label: string): void {
  if (eventIndex(value) === undefined) throw new Error(`Malformed ${label}`)
}

function assertCanonicalString(value: unknown, label: string): void {
  if (typeof value !== 'string') throw new Error(`Malformed ${label}`)
}

function assertCanonicalNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Malformed ${label}`)
}

function assertCanonicalTurnEndReason(value: unknown, name: string): void {
  const reason = objectOrUndefined(value)
  if (reason === undefined || typeof reason.kind !== 'string' || reason.kind.length === 0)
    throw new Error(`Malformed ${name} reason`)
  if (reason.kind === 'aborted') {
    const cancellation = objectOrUndefined(reason.reason)
    if (cancellation === undefined || typeof cancellation.kind !== 'string' || cancellation.kind.length === 0)
      throw new Error(`Malformed ${name} reason`)
  }
  if (reason.kind === 'error') {
    const failure = objectOrUndefined(reason.error)
    if (
      failure === undefined ||
      typeof failure.message !== 'string' ||
      typeof failure.code !== 'string' ||
      failure.code.length === 0
    )
      throw new Error(`Malformed ${name} reason`)
  }
}

function assertCanonicalMessage(value: unknown, name: string): void {
  const message = objectOrUndefined(value)
  if (message === undefined || typeof message.id !== 'string' || message.id.length === 0)
    throw new Error(`Malformed ${name} message`)
  const expectedRole = name === 'assistant/message' ? 'assistant' : 'user'
  if (message.role !== expectedRole) throw new Error(`Malformed ${name} message role`)
  const source = objectOrUndefined(message.source)
  if (source === undefined || typeof source.kind !== 'string' || source.kind.length === 0)
    throw new Error(`Malformed ${name} message source`)
  assertCanonicalContentBlocks(message.content, `${name} message content`)
  if (name === 'assistant/message') {
    if (source.kind !== 'model') throw new Error(`Malformed ${name} message source`)
    assertCanonicalNonEmptyString(source.provider, `${name} message provider`)
    assertCanonicalNonEmptyString(source.model, `${name} message model`)
    return
  }
  if (name !== 'tool/result') return
  if (source.kind !== 'tool') throw new Error(`Malformed ${name} message source`)
  assertCanonicalNonEmptyString(source.callId, `${name} message callId`)
  const block = objectOrUndefined(message.content[0])
  if (
    message.content.length !== 1 ||
    block === undefined ||
    block.type !== 'tool-result' ||
    !Array.isArray(block.content) ||
    block.toolCallId !== source.callId
  )
    throw new Error(`Malformed ${name} message content`)
}

/**
 * Validate the core content blocks without closing the merge-extensible
 * content vocabulary. Unknown block types are left opaque for forward
 * compatibility, while a known image/tool block must not be accepted and
 * then silently disappear in the presentation mapper.
 */
export function assertCanonicalContentBlocks(
  value: unknown,
  label: string,
): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Malformed ${label}`)
  for (const entry of value) {
    const block = objectOrUndefined(entry)
    if (block === undefined || typeof block.type !== 'string' || block.type.length === 0)
      throw new Error(`Malformed ${label}`)
    switch (block.type) {
      case 'text':
      case 'reasoning':
        assertCanonicalString(block.text, `${label} ${block.type} text`)
        break
      case 'image':
        assertCanonicalImageReference(block.attachment, `${label} image attachment`)
        break
      case 'tool-call':
        assertCanonicalNonEmptyString(block.id, `${label} tool-call id`)
        assertCanonicalString(block.name, `${label} tool-call name`)
        assertCanonicalString(block.arguments, `${label} tool-call arguments`)
        break
      case 'tool-result':
        assertCanonicalNonEmptyString(block.toolCallId, `${label} tool-result call id`)
        assertCanonicalContentBlocks(block.content, `${label} tool-result content`)
        if (block.isError !== undefined && typeof block.isError !== 'boolean')
          throw new Error(`Malformed ${label} tool-result isError`)
        break
    }
  }
}

function assertCanonicalImageReference(value: unknown, label: string): void {
  const attachment = objectOrUndefined(value)
  if (
    attachment === undefined ||
    typeof attachment.attachmentId !== 'string' ||
    attachment.attachmentId.trim() === '' ||
    (attachment.mediaType !== 'image/png' &&
      attachment.mediaType !== 'image/jpeg' &&
      attachment.mediaType !== 'image/webp' &&
      attachment.mediaType !== 'image/gif') ||
    positiveSafeNumber(attachment.bytes) === undefined ||
    positiveSafeNumber(attachment.width) === undefined ||
    positiveSafeNumber(attachment.height) === undefined ||
    (attachment.name !== undefined && typeof attachment.name !== 'string')
  )
    throw new Error(`Malformed ${label}`)
}

function assertCanonicalStreamChunk(value: unknown): void {
  const chunk = objectOrUndefined(value)
  if (chunk === undefined || typeof chunk.type !== 'string')
    throw new Error('Malformed assistant/chunk chunk')
  switch (chunk.type) {
    case 'block-start':
      assertCanonicalEventIndex(chunk.index, 'assistant/chunk index')
      assertCanonicalString(chunk.blockType, 'assistant/chunk blockType')
      return
    case 'text-delta':
    case 'reasoning-delta':
      assertCanonicalEventIndex(chunk.index, 'assistant/chunk index')
      assertCanonicalString(chunk.text, `assistant/chunk ${chunk.type} text`)
      return
    case 'tool-call-delta':
      assertCanonicalEventIndex(chunk.index, 'assistant/chunk index')
      assertCanonicalNonEmptyString(chunk.id, 'assistant/chunk tool call id')
      assertCanonicalString(chunk.argumentsDelta, 'assistant/chunk argumentsDelta')
      if (chunk.name !== undefined) assertCanonicalString(chunk.name, 'assistant/chunk tool name')
      return
    case 'block-end': {
      assertCanonicalEventIndex(chunk.index, 'assistant/chunk index')
      const block = objectOrUndefined(chunk.block)
      if (block === undefined || typeof block.type !== 'string')
        throw new Error('Malformed assistant/chunk block')
      return
    }
    case 'usage':
      assertCanonicalTokenUsage(chunk.usage, 'assistant/chunk usage')
      return
    case 'finish': {
      const reason = objectOrUndefined(chunk.reason)
      if (reason === undefined || typeof reason.kind !== 'string' || reason.kind.length === 0)
        throw new Error('Malformed assistant/chunk finish reason')
      return
    }
    default:
      throw new Error('Malformed assistant/chunk chunk')
  }
}

function assertCanonicalTokenUsage(value: unknown, label: string): void {
  const usage = objectOrUndefined(value)
  if (
    usage === undefined ||
    tokenCount(usage.inputTokens) === undefined ||
    tokenCount(usage.outputTokens) === undefined
  )
    throw new Error(`Malformed ${label}`)
  for (const key of ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    if (usage[key] !== undefined && tokenCount(usage[key]) === undefined)
      throw new Error(`Malformed ${label}`)
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
