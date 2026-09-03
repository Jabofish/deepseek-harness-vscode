import {
  AppError,
  type SubagentCatalog,
  type SubagentDiagnosticView,
  type SubagentHistoryPage,
  type SubagentHistoryQuery,
  type PromptAttachment,
  type SubagentRepository,
  type SubagentView,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc, unavailable } from '../versions/rc6/rpc.js'
import { clientTimeZoneField } from '../client-time-zone.js'
import { rc6Mapper } from '../versions/rc6/mapper.js'
import { encodePromptContent } from '../attachment-codec.js'
import { recordOrUndefined, validProjectionBlock } from './shared/guards.js'

type Address = { readonly parentSessionId: string; readonly mode: 'one-shot' | 'continuable' }

/** Match the official web client's 50-message history pages. */
const HISTORY_PAGE_MESSAGES = 50
export interface SubagentRepositoryOptions {
  /** Alpha.3+ admits inline image parts; rc.6/alpha.1-2 accept text parts only. */
  readonly inlineImagePrompts?: boolean
  readonly maxPromptAttachmentBytes?: number
  readonly maxPromptAttachmentTotalBytes?: number
}

export class Rc6SubagentRepository implements SubagentRepository {
  private readonly addresses = new Map<string, Address>()
  private readonly refreshGenerations = new Map<string, number>()

  public constructor(
    private readonly transport: DshTransport,
    private readonly options: SubagentRepositoryOptions = {},
  ) {}

  public async list(sessionId: string, signal?: AbortSignal): Promise<SubagentCatalog> {
    const generation = (this.refreshGenerations.get(sessionId) ?? 0) + 1
    this.refreshGenerations.set(sessionId, generation)
    const value = requiredRecord(
      await callRpc<unknown>(this.transport, 'subagent.list', { parentSessionId: sessionId }, signal),
    )
    if (!Array.isArray(value.entries) || typeof value.parentAvailable !== 'boolean')
      throw malformedSubagentResponse('catalog')
    const entries = value.entries.map((entry) => catalogEntry(entry, sessionId))

    // Commit routing only after the entire catalog validates. A malformed
    // refresh must not leave a half-new address set behind. Concurrent
    // refreshes of the same parent commit in resolution order, so an older
    // response that resolves last must not commit: it would delete children
    // the newer catalog had just routed or revert their modes. A stale
    // refresh still returns its point-in-time view without touching routing.
    if (this.refreshGenerations.get(sessionId) !== generation)
      return { entries, parentAvailable: value.parentAvailable }
    for (const [childId, address] of this.addresses)
      if (address.parentSessionId === sessionId) this.addresses.delete(childId)
    for (const entry of entries)
      if (entry.kind === 'child')
        this.addresses.set(entry.id, { parentSessionId: sessionId, mode: entry.mode })

    return { entries, parentAvailable: value.parentAvailable }
  }

  public async send(
    sessionId: string,
    message: string,
    attachmentsOrSignal: readonly PromptAttachment[] | AbortSignal = [],
    signal?: AbortSignal,
  ): Promise<void> {
    const attachments = Array.isArray(attachmentsOrSignal) ? attachmentsOrSignal : []
    const requestSignal: AbortSignal | undefined = Array.isArray(attachmentsOrSignal)
      ? signal
      : (attachmentsOrSignal as AbortSignal | undefined)
    const address = this.addresses.get(sessionId)
    if (address?.mode !== 'continuable') throw unavailable('one-shot subagent follow-up')
    const content = encodePromptContent(message, attachments, {
      maxImageBytes: this.options.maxPromptAttachmentBytes ?? 20 * 1024 * 1024,
      maxAttachmentTotalBytes: this.options.maxPromptAttachmentTotalBytes ?? 200 * 1024 * 1024,
      maxImageTotalBytes: this.options.maxPromptAttachmentTotalBytes ?? 200 * 1024 * 1024,
    })
    if (content.some((part) => part.type === 'image') && this.options.inlineImagePrompts !== true)
      throw unavailable('subagent image prompts')
    const value = requiredRecord(
      await callRpc<unknown>(
        this.transport,
        'subagent.prompt',
        {
          parentSessionId: address.parentSessionId,
          childSessionId: sessionId,
          mode: address.mode,
          content,
          ...clientTimeZoneField(),
        },
        requestSignal,
      ),
    )
    if (typeof value.messageId !== 'string' || value.messageId.length === 0)
      throw malformedSubagentResponse('prompt receipt')
  }

  public async history(
    sessionId: string,
    query?: SubagentHistoryQuery,
    signal?: AbortSignal,
  ): Promise<SubagentHistoryPage> {
    const address = this.addresses.get(sessionId)
    if (address === undefined) throw unavailable('subagent history without a current catalog entry')
    const value = requiredRecord(
      await callRpc<unknown>(
        this.transport,
        'subagent.history',
        {
          parentSessionId: address.parentSessionId,
          childSessionId: sessionId,
          mode: address.mode,
          maxMessages: HISTORY_PAGE_MESSAGES,
          ...(query?.beforeSequence === undefined ? {} : { beforeSeq: query.beforeSequence }),
        },
        signal,
      ),
    )
    if (
      !Array.isArray(value.events) ||
      typeof value.hasMore !== 'boolean' ||
      (value.projections !== undefined && !validProjectionBlock(value.projections))
    )
      throw malformedSubagentResponse('history')
    const mapped = rc6Mapper.history(value, sessionId)
    return {
      events: mapped.events,
      hasMore: mapped.hasMore,
      ...(mapped.projection === undefined ? {} : { projection: mapped.projection }),
    }
  }

  public async interrupt(sessionId: string, signal?: AbortSignal): Promise<void> {
    const address = this.addresses.get(sessionId)
    if (address?.mode !== 'continuable') throw unavailable('one-shot subagent interrupt')
    const value = requiredRecord(
      await callRpc<unknown>(
        this.transport,
        'subagent.interrupt',
        { parentSessionId: address.parentSessionId, childSessionId: sessionId, mode: address.mode },
        signal,
      ),
    )
    if (value.accepted !== true) throw malformedSubagentResponse('interrupt receipt')
  }
}

function catalogEntry(value: unknown, parentSessionId: string): SubagentView | SubagentDiagnosticView {
  const record = requiredRecord(value)
  if (typeof record.id !== 'string' || record.id.length === 0)
    throw malformedSubagentResponse('catalog entry')
  if (record.kind === 'diagnostic') {
    if (record.reason !== 'corrupt' && record.reason !== 'unsupported' && record.reason !== 'unavailable')
      throw malformedSubagentResponse('diagnostic entry')
    return { kind: 'diagnostic', id: record.id, parentSessionId, reason: record.reason }
  }
  if (
    record.kind !== 'child' ||
    (record.activity !== 'running' && record.activity !== 'inactive') ||
    typeof record.hasChildren !== 'boolean' ||
    (record.mode !== 'one-shot' && record.mode !== 'continuable') ||
    (record.label !== undefined && typeof record.label !== 'string') ||
    (record.mode === 'continuable' && typeof record.label !== 'string')
  )
    throw malformedSubagentResponse('child entry')
  return {
    kind: 'child',
    id: record.id,
    activity: record.activity,
    hasChildren: record.hasChildren,
    mode: record.mode,
    parentSessionId,
    ...(record.label === undefined ? {} : { label: record.label }),
  }
}

function requiredRecord(value: unknown): Record<string, unknown> {
  const record = recordOrUndefined(value)
  if (record !== undefined) return record
  throw malformedSubagentResponse('response')
}

function malformedSubagentResponse(part: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed subagent ${part}.`,
    retryable: false,
  })
}
