import { AppError } from '@dsh-vscode/domain'
import { isSupportedImageMimeType } from '../../attachment-codec.js'
import { recordOrUndefined, validProjectionBlock } from '../shared/guards.js'

export function malformedSessionResponse(method: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed ${method} response.`,
    retryable: false,
  })
}

export function requiredRecord(value: unknown, method: string): Record<string, unknown> {
  const record = recordOrUndefined(value)
  if (record !== undefined) return record
  throw malformedSessionResponse(method)
}

export function requiredSessionId(value: Record<string, unknown>, method: string): string {
  if (typeof value.sessionId === 'string' && value.sessionId.trim() !== '') return value.sessionId
  throw malformedSessionResponse(`${method} receipt`)
}

/** Validated rename receipt: the title the host stored, not the requested text. */
export function acceptedRenameTitle(value: unknown): string {
  const record = recordOrUndefined(value)
  if (
    record !== undefined &&
    typeof record.title === 'string' &&
    record.title.trim() !== '' &&
    Number.isSafeInteger(record.seq) &&
    (record.seq as number) >= 0
  )
    return record.title
  throw malformedSessionResponse('session rename receipt')
}

export function assertModelSelection(value: unknown): void {
  const selected = recordOrUndefined(recordOrUndefined(value)?.selected)
  if (
    selected !== undefined &&
    typeof selected.provider === 'string' &&
    selected.provider.trim() !== '' &&
    typeof selected.model === 'string' &&
    selected.model.trim() !== '' &&
    (selected.reasoningEffort === undefined || isNonEmptyString(selected.reasoningEffort))
  )
    return
  throw malformedSessionResponse('session model selection receipt')
}

export function validSessionSummaryResponse(value: unknown): boolean {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    typeof record.sessionId === 'string' &&
    record.sessionId.trim() !== '' &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt) &&
    record.updatedAt >= 0 &&
    typeof record.running === 'boolean' &&
    typeof record.blank === 'boolean' &&
    (record.workspaceId === undefined || typeof record.workspaceId === 'string') &&
    (record.parentSessionId === undefined ||
      (typeof record.parentSessionId === 'string' && record.parentSessionId.trim() !== '')) &&
    (record.origin === undefined || record.origin === 'subagent') &&
    (record.agentAvailable === undefined || typeof record.agentAvailable === 'boolean') &&
    (record.cwd === undefined || typeof record.cwd === 'string') &&
    (record.agentPreset === undefined || typeof record.agentPreset === 'string') &&
    (record.projections === undefined || validProjectionBlock(record.projections))
  )
}

export function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry): entry is string => isNonEmptyString(entry))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export function validHistoryResponse(
  value: unknown,
): value is { readonly events: unknown[]; readonly hasMore: boolean } {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    Array.isArray(record.events) &&
    record.events.every(validHistoryEntry) &&
    typeof record.hasMore === 'boolean' &&
    (record.projections === undefined || validProjectionBlock(record.projections))
  )
}

function validHistoryEntry(value: unknown): boolean {
  const entry = recordOrUndefined(value)
  const event = recordOrUndefined(entry?.event)
  return (
    entry !== undefined &&
    event !== undefined &&
    typeof event.type === 'string' &&
    event.type.trim() !== '' &&
    Number.isSafeInteger(event.seq) &&
    (event.seq as number) >= 0 &&
    typeof event.time === 'number' &&
    Number.isFinite(event.time) &&
    (entry.view === undefined || recordOrUndefined(entry.view) !== undefined)
  )
}

export function validAttachmentReference(value: Record<string, unknown>, requestedId: string): boolean {
  return (
    typeof value.attachmentId === 'string' &&
    value.attachmentId === requestedId &&
    typeof value.mediaType === 'string' &&
    isSupportedImageMimeType(value.mediaType) &&
    Number.isSafeInteger(value.bytes) &&
    (value.bytes as number) > 0 &&
    Number.isSafeInteger(value.width) &&
    (value.width as number) > 0 &&
    Number.isSafeInteger(value.height) &&
    (value.height as number) > 0 &&
    (value.name === undefined || typeof value.name === 'string')
  )
}
