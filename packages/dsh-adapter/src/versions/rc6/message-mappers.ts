import type {
  MessageAttachment,
  MessageImageReference,
  TokenUsage,
  TurnEndFailure,
  TurnEndReasonKind,
} from '@dsh-vscode/domain'

import { attachedFileEnvelope } from '../../attachment-codec.js'
import {
  array,
  contentEntries,
  firstString,
  indexToken,
  optionalText,
  positiveSafeInteger,
  stringOr,
  tokenCount,
} from './value-guards.js'
import { recordOrUndefined as objectOrUndefined } from '../../repositories/shared/guards.js'

export function turnEndReason(value: unknown): TurnEndReasonKind {
  const kind = objectOrUndefined(value)?.kind ?? value
  return kind === 'completed' ||
    kind === 'aborted' ||
    kind === 'blocked' ||
    kind === 'error' ||
    kind === 'max-tokens' ||
    kind === 'interrupted'
    ? kind
    : 'unknown'
}

/**
 * Preserve the rc.1 structured turn failure without forwarding provider-owned
 * metadata. Older hosts simply omit this field and keep the generic terminal
 * reason projection.
 */
export function turnEndFailure(value: unknown): TurnEndFailure | undefined {
  const reason = objectOrUndefined(value)
  if (reason?.kind !== 'error') return undefined
  const failure = objectOrUndefined(reason.error)
  if (failure === undefined) return undefined
  const message = safeFailureText(failure.message)
  if (message === undefined) return undefined
  const code = safeFailureCode(failure.code)
  return { message, ...(code === undefined ? {} : { code }) }
}

function safeFailureText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const compact = value.replace(/\s+/gu, ' ').trim()
  if (compact === '') return undefined
  const redacted = compact.replace(
    /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret|private[_ -]?key|token|prompt|body|response)\b\s*[:=]\s*[^\s,;]+/giu,
    (match) => match.replace(/[:=].*$/u, ': [redacted]'),
  )
  // The host bounds this nowhere: the durable `turn/end` reason carries the
  // provider adapter's own `LlmError` message (the provider's `error.message`
  // for an HTTP failure), and the reference client renders it whole in its
  // turn-error row. Clipping would cut the user's only diagnosis with no
  // ellipsis or copy surface that reveals the loss.
  return redacted
}

function safeFailureCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(value) ? value : undefined
}

export function assistantMessageId(data: Record<string, unknown>, message?: Record<string, unknown>): string {
  const explicitId = [data.messageId, message?.id, data.id].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  )
  if (explicitId !== undefined) return explicitId
  const turn = indexToken(data.turn)
  const step = indexToken(data.step)
  if (turn !== undefined && step !== undefined) return `assistant:${turn}:${step}`
  return 'assistant:unknown'
}

export function messageText(value: Record<string, unknown> | undefined): string {
  if (value === undefined) return ''
  const content = contentEntries(value.content)
  if (content.length === 0) return stringOr(value.text ?? value.markdown ?? value.content, '')
  return contentText(content, false)
}

interface UserMessageContent {
  readonly markdown: string
  readonly attachments: readonly MessageAttachment[]
  readonly images: readonly MessageImageReference[]
}

/**
 * Project the user-facing part of a durable message without changing what
 * DSH received. rc.6 has no text-file attachment block: promptContent sends
 * text files as a deliberately marked text block so the model can read them.
 * Recognize only that exact adapter-owned envelope and keep its filename as
 * metadata; ordinary user text is left untouched.
 *
 * A newer host admits real `file` parts instead, and the same filename chip
 * reports them: the bytes stay host-side, so a message whose only content is a
 * file must still render as something rather than vanish.
 */
export function userMessageContent(value: Record<string, unknown> | undefined): UserMessageContent {
  if (value === undefined) return { markdown: '', attachments: [], images: [] }
  const content = array(value.content)
  if (content.length === 0) {
    const text = stringOr(value.text ?? value.markdown ?? value.content, '')
    const parsed = attachedFileEnvelope(text)
    return parsed === undefined
      ? { markdown: text, attachments: [], images: [] }
      : { markdown: '', attachments: [{ name: parsed.name }], images: [] }
  }

  const textParts: string[] = []
  const attachments: MessageAttachment[] = []
  const images: MessageImageReference[] = []
  for (const entry of content) {
    const block = objectOrUndefined(entry)
    if (block?.type === 'text' && typeof block.text === 'string') {
      const parsed = attachedFileEnvelope(block.text)
      if (parsed !== undefined) {
        attachments.push({ name: parsed.name })
        continue
      }
      textParts.push(block.text)
      continue
    }
    if (block?.type === 'image') {
      const image = imageReference(block.attachment)
      if (image !== undefined) {
        images.push(image)
        continue
      }
    }
    if (block?.type === 'file') {
      const attachment = objectOrUndefined(block.attachment)
      const name = typeof attachment?.name === 'string' ? attachment.name.trim() : ''
      // An unnamed file part still has to render as something: the message
      // carries content the client cannot read back.
      attachments.push(name === '' ? { name: '[file]' } : { name })
      continue
    }
    const text = contentText([entry], false)
    if (text !== '') textParts.push(text)
  }
  return { markdown: textParts.join('\n'), attachments, images: uniqueImages(images) }
}

/**
 * Keep only the labels needed to render the upstream session-reference chip.
 * The durable source also carries capture statistics and session ids; those
 * stay on the Host side and never cross into the Webview projection.
 */
export function structuredSessionReferenceLabels(
  source: Record<string, unknown> | undefined,
): readonly string[] {
  if (source?.kind !== 'session-reference') return []
  if (!Array.isArray(source.references) || source.references.length > 32)
    throw new Error('Malformed session-reference references')
  const labels: string[] = []
  for (const entry of source.references) {
    const reference = objectOrUndefined(entry)
    if (
      reference === undefined ||
      typeof reference.sessionId !== 'string' ||
      reference.sessionId.trim() === '' ||
      reference.sessionId.length > 512 ||
      typeof reference.label !== 'string' ||
      reference.label.trim() === '' ||
      reference.label.length > 512
    )
      throw new Error('Malformed session-reference entry')
    if (!labels.includes(reference.label)) labels.push(reference.label)
  }
  return labels
}

export function messageImages(value: Record<string, unknown> | undefined): readonly MessageImageReference[] {
  if (value === undefined) return []
  const images: MessageImageReference[] = []
  for (const entry of array(value.content)) {
    const block = objectOrUndefined(entry)
    if (block?.type !== 'image') continue
    const image = imageReference(block.attachment)
    if (image !== undefined) images.push(image)
  }
  return uniqueImages(images)
}

export function toolResultImages(
  message: Record<string, unknown> | undefined,
  dispatchContent: unknown,
  callId: string,
): readonly MessageImageReference[] {
  const content = message === undefined ? array(dispatchContent) : array(message.content)
  const blocks = content.flatMap((entry) => {
    const block = objectOrUndefined(entry)
    if (block?.type === 'tool-result') return block.toolCallId === callId ? array(block.content) : []
    return [entry]
  })
  return messageImages({ content: blocks })
}

function imageReference(value: unknown): MessageImageReference | undefined {
  const record = objectOrUndefined(value)
  if (record === undefined) return undefined
  const attachmentId = stringOr(record.attachmentId ?? record.id, '').trim()
  const mediaType = record.mediaType
  const bytes = positiveSafeInteger(record.bytes)
  const width = positiveSafeInteger(record.width)
  const height = positiveSafeInteger(record.height)
  if (
    attachmentId === '' ||
    (mediaType !== 'image/png' &&
      mediaType !== 'image/jpeg' &&
      mediaType !== 'image/webp' &&
      mediaType !== 'image/gif') ||
    bytes === undefined ||
    width === undefined ||
    height === undefined
  )
    return undefined
  const name = optionalText(record.name)
  return {
    attachmentId,
    mediaType,
    bytes,
    width,
    height,
    ...(name === undefined ? {} : { name }),
  }
}

function uniqueImages(images: readonly MessageImageReference[]): readonly MessageImageReference[] {
  const seen = new Set<string>()
  const result: MessageImageReference[] = []
  for (const image of images) {
    if (seen.has(image.attachmentId)) continue
    seen.add(image.attachmentId)
    result.push(image)
    if (result.length >= 32) break
  }
  return result
}

export function reasoningText(value: Record<string, unknown> | undefined): string {
  if (value === undefined) return ''
  return (
    contentText(contentEntries(value.content), true) ||
    stringOr(value.reasoning ?? value.reasoningContent ?? value.reasoning_content, '')
  )
}

export function contentText(content: readonly unknown[], reasoningOnly: boolean): string {
  return content
    .map((entry) => {
      if (typeof entry === 'string') return reasoningOnly ? '' : entry
      const block = objectOrUndefined(entry)
      if (block === undefined) return ''
      if (block.type === 'reasoning') return reasoningOnly ? stringOr(block.text, '') : ''
      if (reasoningOnly) return ''
      if (block.type === 'text') return stringOr(block.text, '')
      if (block.type === 'image') return imageReference(block.attachment) === undefined ? '[image]' : ''
      if (block.type === 'tool-result') {
        const nested = contentText(contentEntries(block.content), false)
        return nested || stringOr(block.text ?? block.message, '[tool result]')
      }
      if (block.type === 'tool-call') return ''
      return stringOr(block.text ?? block.value, '') || contentText(contentEntries(block.content), false)
    })
    .filter(Boolean)
    .join('\n')
}

export function assistantModelLabel(
  message: Record<string, unknown>,
  envelope: Record<string, unknown>,
): string | undefined {
  const source = objectOrUndefined(message.source)
  const model = objectOrUndefined(message.model) ?? objectOrUndefined(envelope.model)
  return firstString(
    message.modelLabel,
    model?.label,
    model?.name,
    message.modelId,
    model?.modelId,
    typeof message.model === 'string' ? message.model : undefined,
    source?.model,
    source?.modelId,
    envelope.modelId,
    typeof envelope.model === 'string' ? envelope.model : undefined,
  )
}

export function tokenUsage(value: unknown): TokenUsage | undefined {
  const record = objectOrUndefined(value)
  if (record === undefined) return undefined
  const inputTokens = tokenCount(record.inputTokens ?? record.uncachedInputTokens)
  const outputTokens = tokenCount(record.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const totalTokens = record.totalTokens === undefined ? undefined : tokenCount(record.totalTokens)
  const cacheReadTokens = tokenCount(record.cacheReadTokens)
  const cacheWriteTokens = tokenCount(record.cacheWriteTokens)
  const reasoningTokens = tokenCount(record.reasoningTokens)
  if (
    (record.totalTokens !== undefined && totalTokens === undefined) ||
    (record.cacheReadTokens !== undefined && cacheReadTokens === undefined) ||
    (record.cacheWriteTokens !== undefined && cacheWriteTokens === undefined) ||
    (record.reasoningTokens !== undefined && reasoningTokens === undefined)
  )
    return undefined
  return {
    inputTokens,
    outputTokens,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

/** Read the final usage sample without expanding compact text and tool records. */
export function assistantStreamUsage(value: unknown): TokenUsage | undefined {
  if (!Array.isArray(value)) return undefined
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const record = objectOrUndefined(value[index])
    if (record?.type !== 'chunk') continue
    const chunk = objectOrUndefined(record.chunk)
    if (chunk?.type === 'usage') return tokenUsage(chunk.usage)
  }
  return undefined
}
