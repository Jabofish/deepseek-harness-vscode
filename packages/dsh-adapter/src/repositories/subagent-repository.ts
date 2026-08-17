import {
  AppError,
  type SubagentCatalog,
  type SubagentDiagnosticView,
  type SubagentHistoryPage,
  type SubagentRepository,
  type SubagentView,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc, unavailable } from '../versions/rc6/rpc.js'
import { rc6Mapper } from '../versions/rc6/mapper.js'

type Address = { readonly parentSessionId: string; readonly mode: 'one-shot' | 'continuable' }

export class Rc6SubagentRepository implements SubagentRepository {
  private readonly addresses = new Map<string, Address>()

  public constructor(private readonly transport: DshTransport) {}

  public async list(sessionId: string, signal?: AbortSignal): Promise<SubagentCatalog> {
    const value = requiredRecord(
      await callRpc<unknown>(this.transport, 'subagent.list', { parentSessionId: sessionId }, signal),
    )
    if (!Array.isArray(value.entries) || typeof value.parentAvailable !== 'boolean')
      throw malformedSubagentResponse('catalog')
    const entries = value.entries.map((entry) => catalogEntry(entry, sessionId))

    // Commit routing only after the entire catalog validates. A malformed
    // refresh must not leave a half-new address set behind.
    for (const [childId, address] of this.addresses)
      if (address.parentSessionId === sessionId) this.addresses.delete(childId)
    for (const entry of entries)
      if (entry.kind === 'child')
        this.addresses.set(entry.id, { parentSessionId: sessionId, mode: entry.mode })

    return { entries, parentAvailable: value.parentAvailable }
  }

  public async send(sessionId: string, message: string, signal?: AbortSignal): Promise<void> {
    const address = this.addresses.get(sessionId)
    if (address?.mode !== 'continuable') throw unavailable('one-shot subagent follow-up')
    const value = requiredRecord(
      await callRpc<unknown>(
        this.transport,
        'subagent.prompt',
        {
          parentSessionId: address.parentSessionId,
          childSessionId: sessionId,
          mode: address.mode,
          content: [{ type: 'text', text: message }],
        },
        signal,
      ),
    )
    if (typeof value.messageId !== 'string' || value.messageId.length === 0)
      throw malformedSubagentResponse('prompt receipt')
  }

  public async history(sessionId: string, signal?: AbortSignal): Promise<SubagentHistoryPage> {
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
          maxMessages: 200,
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

function validProjectionBlock(value: unknown): boolean {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    Number.isSafeInteger(record.asOfSeq) &&
    (record.asOfSeq as number) >= -1 &&
    recordOrUndefined(record.values) !== undefined
  )
}

function requiredRecord(value: unknown): Record<string, unknown> {
  const record = recordOrUndefined(value)
  if (record !== undefined) return record
  throw malformedSubagentResponse('response')
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function malformedSubagentResponse(part: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed subagent ${part}.`,
    retryable: false,
  })
}
