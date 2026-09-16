import {
  AppError,
  type SubagentCatalog,
  type SubagentDiagnosticView,
  type SubagentHistoryPage,
  type SubagentHistoryQuery,
  type PromptAttachment,
  type RunningInputMode,
  type SubagentRepository,
  type SubagentView,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc, unavailable } from '../versions/rc6/rpc.js'
import { clientTimeZoneField } from '../client-time-zone.js'
import { rc6Mapper } from '../versions/rc6/mapper.js'
import { encodePromptContent } from '../attachment-codec.js'
import { recordOrUndefined, validProjectionBlock } from './shared/guards.js'
import { SubagentAddressRegistry } from './shared/subagent-addresses.js'

/** Match the official web client's 50-message history pages. */
const HISTORY_PAGE_MESSAGES = 50
export interface SubagentRepositoryOptions {
  /** Alpha.3+ admits inline image parts; rc.6/alpha.1-2 accept text parts only. */
  readonly inlineImagePrompts?: boolean
  /** DSH 0.1.3-alpha.2 requires the queue/steer delivery discriminator. */
  readonly subagentPromptDelivery?: boolean
  readonly maxPromptAttachmentBytes?: number
  readonly maxPromptAttachmentTotalBytes?: number
  /** 0.0.1-rc.1 predates the browser-local time-zone field. */
  readonly includeClientTimeZone?: boolean
  /**
   * Routing committed by the catalog, shared with the transport so a child's
   * live stream and history reads use the same durable descriptor.
   */
  readonly addresses?: SubagentAddressRegistry
}

export class Rc6SubagentRepository implements SubagentRepository {
  private readonly addresses: SubagentAddressRegistry
  private readonly refreshGenerations = new Map<string, number>()

  public constructor(
    private readonly transport: DshTransport,
    private readonly options: SubagentRepositoryOptions = {},
  ) {
    this.addresses = options.addresses ?? new SubagentAddressRegistry()
  }

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
    this.addresses.replaceParent(
      sessionId,
      entries
        .filter((entry): entry is SubagentView => entry.kind === 'child')
        .map((entry) => ({ id: entry.id, mode: entry.mode })),
    )

    return { entries, parentAvailable: value.parentAvailable }
  }

  /** Durable parent of a catalog-resolved child, for child-scoped ownership checks. */
  public parentOf(childSessionId: string): string | undefined {
    return this.addresses.parentOf(childSessionId)
  }

  public send(sessionId: string, message: string, signal?: AbortSignal): Promise<void>
  public send(
    sessionId: string,
    message: string,
    attachments?: readonly PromptAttachment[],
    signal?: AbortSignal,
  ): Promise<void>
  public send(
    sessionId: string,
    message: string,
    attachments?: readonly PromptAttachment[],
    mode?: RunningInputMode,
    signal?: AbortSignal,
  ): Promise<void>
  public async send(
    sessionId: string,
    message: string,
    attachmentsOrSignal: readonly PromptAttachment[] | AbortSignal = [],
    modeOrSignal: RunningInputMode | AbortSignal = 'queue',
    signal?: AbortSignal,
  ): Promise<void> {
    const attachments = isAbortSignal(attachmentsOrSignal) ? [] : attachmentsOrSignal
    const mode = isAbortSignal(modeOrSignal) ? 'queue' : modeOrSignal
    const requestSignal = isAbortSignal(attachmentsOrSignal)
      ? attachmentsOrSignal
      : isAbortSignal(modeOrSignal)
        ? modeOrSignal
        : signal
    const address = this.addresses.resolve(sessionId)
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
          ...(this.options.subagentPromptDelivery === true ? { delivery: mode } : {}),
          content,
          ...(this.options.includeClientTimeZone === false ? {} : clientTimeZoneField()),
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
    const address = this.addresses.resolve(sessionId)
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
    // Map the hidden marker rows while calculating the page cursor: a page
    // whose first record is the model-facing system prompt would otherwise
    // report a cursor that leaves that record unreachable for paging.
    const mapped = rc6Mapper.history(value, sessionId, { includeSystemMarkers: true })
    const sequences = mapped.events.map((entry) => entry.sequence).filter((entry) => entry >= 0)
    const oldest = sequences.length === 0 ? undefined : Math.min(...sequences)
    return {
      events: mapped.events.filter((entry) => entry.event.type !== 'session.system'),
      hasMore: mapped.hasMore,
      ...(oldest === undefined ? {} : { beforeSequence: oldest }),
      ...(mapped.projection === undefined ? {} : { projection: mapped.projection }),
    }
  }

  public async interrupt(sessionId: string, signal?: AbortSignal): Promise<void> {
    const address = this.addresses.resolve(sessionId)
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

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === 'object' && value !== null && 'aborted' in value && 'addEventListener' in value
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
