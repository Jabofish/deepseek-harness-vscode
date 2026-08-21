import {
  AppError,
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

/** Optional rc.8 sidecar adapter. All DSH calls remain in the Extension Host. */
export class Rc6MessageFeedbackRepository implements MessageFeedbackRepository {
  private readonly versions = new Map<string, string>()

  public constructor(private readonly transport: DshTransport) {}

  public async list(sessionId: string, signal?: AbortSignal): Promise<readonly MessageFeedbackItem[]> {
    try {
      const value = readBusinessValue(
        await this.transport.remoteRequest<unknown>(
          'messageFeedback/list',
          { request: { sessionId } },
          signal,
        ),
        'messageFeedback/list',
      )
      const record = asRecord(value)
      if (!Array.isArray(record?.items)) throw malformed('message feedback list')
      return record.items.flatMap((item) => {
        const parsed = parseItem(item)
        if (parsed !== undefined) this.versions.set(`${sessionId}:${parsed.messageId}`, parsed.version)
        return parsed === undefined ? [] : [parsed]
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
    signal?: AbortSignal,
  ): Promise<MessageFeedbackItem> {
    const request = {
      sessionId,
      messageId,
      rating,
      ...(note === undefined ? {} : { note }),
      ifVersion: this.versions.get(`${sessionId}:${messageId}`) ?? null,
    }
    try {
      const response = await this.transport.remoteRequest<unknown>('messageFeedback/put', { request }, signal)
      const value = readBusinessValue(response, 'messageFeedback/put')
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
    const version = this.versions.get(`${sessionId}:${messageId}`)
    if (version === undefined) return
    try {
      const response = await this.transport.remoteRequest<unknown>(
        'messageFeedback/delete',
        { request: { sessionId, messageId, ifVersion: version } },
        signal,
      )
      const value = readBusinessValue(response, 'messageFeedback/delete')
      if (asRecord(value)?.absent !== true) throw malformed('message feedback delete receipt')
      this.versions.delete(`${sessionId}:${messageId}`)
    } catch (error) {
      if (isOptionalUnavailable(error)) throw unavailable('message feedback')
      throw error
    }
  }
}

function readBusinessValue(value: unknown, method: string): unknown {
  const outer = unwrapRpcResultValue<unknown>(value, method)
  const result = outer as FeedbackRemoteResult
  if (typeof result === 'object' && result !== null && typeof result.ok === 'boolean') {
    if (result.ok && 'value' in result) return result.value
    if (!result.ok) {
      const code = typeof result.error?.code === 'string' ? result.error.code : 'internal'
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

function parseItem(value: unknown): MessageFeedbackItem | undefined {
  const record = asRecord(value)
  if (
    record === undefined ||
    typeof record.messageId !== 'string' ||
    record.messageId.trim() === '' ||
    (record.rating !== 'positive' && record.rating !== 'negative') ||
    typeof record.version !== 'string' ||
    record.version.trim() === '' ||
    (record.note !== undefined && typeof record.note !== 'string') ||
    (record.createdAt !== undefined && !safeTime(record.createdAt)) ||
    (record.updatedAt !== undefined && !safeTime(record.updatedAt))
  )
    return undefined
  return {
    messageId: record.messageId,
    rating: record.rating,
    ...(record.note === undefined ? {} : { note: record.note }),
    version: record.version,
    ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
    ...(record.updatedAt === undefined ? {} : { updatedAt: record.updatedAt }),
  }
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
