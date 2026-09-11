import {
  AppError,
  type FeedbackCategory,
  type MessageFeedbackItem,
  type MessageFeedbackRating,
  type MessageFeedbackRepository,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { unavailable, unwrapRpcResultValue } from '../versions/rc6/rpc.js'

type FeedbackRemoteResult = {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly code?: unknown; readonly current?: unknown }
}

/** Optional message-feedback sidecar adapter. All DSH calls remain in the Extension Host. */
export class Rc6MessageFeedbackRepository implements MessageFeedbackRepository {
  private readonly versions = new Map<string, string>()

  public constructor(private readonly transport: DshTransport) {}

  public async list(sessionId: string, signal?: AbortSignal): Promise<readonly MessageFeedbackItem[]> {
    try {
      const value = this.readBusinessValue(
        await this.transport.remoteRequest<unknown>(
          'messageFeedback/list',
          { request: { sessionId } },
          signal,
        ),
        'messageFeedback/list',
      )
      const record = asRecord(value)
      if (!Array.isArray(record?.items)) throw malformed('message feedback list')
      return record.items.map((item) => {
        const parsed = parseItem(item)
        if (parsed === undefined) throw malformed('message feedback item')
        this.versions.set(`${sessionId}:${parsed.messageId}`, parsed.version)
        return parsed
      })
    } catch (error) {
      if (isOptionalUnavailable(error)) return []
      throw error
    }
  }

  public async put(
    sessionId: string,
    messageId: string,
    rating: MessageFeedbackRating,
    note?: string,
    category?: FeedbackCategory,
    signal?: AbortSignal,
  ): Promise<MessageFeedbackItem> {
    const request = {
      sessionId,
      messageId,
      rating,
      ...(note === undefined ? {} : { note }),
      ...(category === undefined ? {} : { category }),
      ifVersion: this.versions.get(`${sessionId}:${messageId}`) ?? null,
    }
    try {
      const response = await this.transport.remoteRequest<unknown>('messageFeedback/put', { request }, signal)
      const value = this.readBusinessValue(response, 'messageFeedback/put', sessionId, messageId)
      const item = parseItem(value)
      if (item === undefined) throw malformed('message feedback item')
      this.versions.set(`${sessionId}:${messageId}`, item.version)
      return item
    } catch (error) {
      if (isOptionalUnavailable(error)) throw unavailable('message feedback')
      throw error
    }
  }

  public async remove(sessionId: string, messageId: string, signal?: AbortSignal): Promise<void> {
    const key = `${sessionId}:${messageId}`
    let version = this.versions.get(key)
    if (version === undefined) {
      // Upstream delete is a compare-and-swap on the observed item version and
      // an already-absent item is a successful no-op, so a cold cache must
      // observe the session's feedback before it can truthfully delete — or
      // truthfully report that there is nothing to delete.
      const observed = (await this.list(sessionId, signal)).find((item) => item.messageId === messageId)
      if (observed === undefined) return
      version = observed.version
    }
    try {
      const response = await this.transport.remoteRequest<unknown>(
        'messageFeedback/delete',
        { request: { sessionId, messageId, ifVersion: version } },
        signal,
      )
      const value = this.readBusinessValue(response, 'messageFeedback/delete', sessionId, messageId)
      if (asRecord(value)?.absent !== true) throw malformed('message feedback delete receipt')
      this.versions.delete(key)
    } catch (error) {
      if (isOptionalUnavailable(error)) throw unavailable('message feedback')
      throw error
    }
  }

  /**
   * Unwrap the Remote business union. On a version conflict the Host returns
   * the authoritative current item so callers can reconcile without a second
   * read; adopting its version keeps the invited retry CAS-valid.
   */
  private readBusinessValue(value: unknown, method: string, sessionId?: string, messageId?: string): unknown {
    const outer = unwrapRpcResultValue<unknown>(value, method)
    const result = outer as FeedbackRemoteResult
    if (typeof result === 'object' && result !== null && typeof result.ok === 'boolean') {
      if (result.ok && 'value' in result) return result.value
      if (!result.ok) {
        const code = typeof result.error?.code === 'string' ? result.error.code : 'internal'
        if (code === 'version-conflict' && sessionId !== undefined && messageId !== undefined) {
          const current = parseItem(result.error?.current)
          if (current !== undefined) this.versions.set(`${sessionId}:${messageId}`, current.version)
        }
        throw new AppError({
          code:
            code === 'version-conflict'
              ? 'BACKEND_BUSY'
              : code === 'target-not-found' || code === 'unknown-command'
                ? 'CAPABILITY_UNAVAILABLE'
                : 'INTERNAL_ERROR',
          message:
            code === 'version-conflict'
              ? 'The DSH feedback changed; retry the action.'
              : code === 'unknown-command'
                ? 'This DSH host does not expose message feedback.'
                : 'The DSH feedback action was rejected.',
          retryable: code === 'version-conflict',
        })
      }
    }
    return outer
  }
}

function parseItem(value: unknown): MessageFeedbackItem | undefined {
  if (value === null || value === undefined) return undefined
  const record = asRecord(value)
  const createdAt = record?.createdAt
  const updatedAt = record?.updatedAt
  if (
    record === undefined ||
    typeof record.messageId !== 'string' ||
    record.messageId.trim() === '' ||
    (record.rating !== 'positive' && record.rating !== 'negative') ||
    typeof record.version !== 'string' ||
    record.version.trim() === '' ||
    (record.note !== undefined && (typeof record.note !== 'string' || record.note.trim() === '')) ||
    (record.category !== undefined && !isFeedbackCategory(record.category)) ||
    !safeTime(createdAt) ||
    !safeTime(updatedAt) ||
    updatedAt < createdAt
  )
    throw malformed('message feedback item')
  return {
    messageId: record.messageId,
    rating: record.rating,
    ...(record.note === undefined ? {} : { note: record.note }),
    ...(record.category === undefined ? {} : { category: record.category }),
    version: record.version,
    createdAt,
    updatedAt,
  }
}

function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return (
    value === 'task-result' ||
    value === 'instruction-following' ||
    value === 'product-interaction' ||
    value === 'service-stability' ||
    value === 'resource-cost' ||
    value === 'security-privacy-permission' ||
    value === 'other'
  )
}

function safeTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function malformed(kind: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned malformed ${kind}.`,
    retryable: false,
  })
}

function isOptionalUnavailable(error: unknown): boolean {
  if (!(error instanceof AppError)) return false
  if (error.code === 'CAPABILITY_UNAVAILABLE') return true
  return error.code === 'INVALID_CONFIGURATION' && error.context?.rpcCode === 'unknown-command'
}
