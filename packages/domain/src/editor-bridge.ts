import { isCanonicalWorkspaceRelativePath } from './feature-contracts.js'
import type { EditorCompanionRepository } from './editor-companion.js'

/** Version of our optional companion protocol, independent of DSH's wire version. */
export const EDITOR_BRIDGE_PROTOCOL = 1
export const EDITOR_BRIDGE_TOOL = 'vscode_get_editor_state'
export const EDITOR_BRIDGE_FAILURES = [
  'unavailable',
  'busy',
  'not-bound',
  'stale-request',
  'cancelled',
  'timeout',
  'no-editor',
  'workspace-mismatch',
  'untrusted',
  'invalid-response',
] as const
export type EditorBridgeFailure = (typeof EDITOR_BRIDGE_FAILURES)[number]

/** Metadata only. Coordinates are one-based UTF-16; diagnostic counts are cached observations. */
export interface EditorStateSnapshot {
  readonly relativePath: string
  readonly languageId: string
  readonly documentVersion: number
  readonly dirty: boolean
  readonly selection: {
    readonly start: { readonly line: number; readonly column: number }
    readonly end: { readonly line: number; readonly column: number }
  }
  readonly diagnostics: { readonly errors: number; readonly warnings: number }
  readonly capturedAt: string
}

export type EditorBridgeReply =
  | { readonly ok: true; readonly snapshot: EditorStateSnapshot }
  | { readonly ok: false; readonly reason: EditorBridgeFailure }
export interface EditorBridgeBinding {
  /** Host-only opaque lease. Never publish this in a Webview or log. */
  readonly bindingId: string
  readonly protocolVersion: 1
}
export type EditorBridgePoll =
  { readonly kind: 'idle' } | { readonly kind: 'request'; readonly requestId: string }

export type EditorBridgeResult<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'error'; readonly reason: EditorBridgeFailure }

export class EditorBridgeError extends Error {
  public constructor(public readonly reason: EditorBridgeFailure) {
    super(`VS Code editor state is unavailable (${reason}).`)
    this.name = 'EditorBridgeError'
  }
}

export function isEditorBridgeResult<T>(
  value: unknown,
  accepts: (value: unknown) => value is T,
): value is EditorBridgeResult<T> {
  return (
    (record(value, ['status', 'value']) && value.status === 'ok' && accepts(value.value)) ||
    (record(value, ['status', 'reason']) && value.status === 'error' && isEditorBridgeFailure(value.reason))
  )
}

export interface EditorBridgeRepository {
  readonly companion?: EditorCompanionRepository
  attach(sessionId: string, ownerId: string, signal?: AbortSignal): Promise<EditorBridgeBinding>
  poll(bindingId: string, signal?: AbortSignal): Promise<EditorBridgePoll>
  respond(bindingId: string, requestId: string, reply: EditorBridgeReply, signal?: AbortSignal): Promise<void>
  detach(bindingId: string, signal?: AbortSignal): Promise<void>
}

export interface EditorStatePort {
  read(signal: AbortSignal): Promise<EditorStateSnapshot>
}

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}
function integer(value: unknown, minimum = 0): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= 1_000_000_000
  )
}
function position(value: unknown): value is { line: number; column: number } {
  return record(value, ['line', 'column']) && integer(value.line, 1) && integer(value.column, 1)
}
export function isEditorStateSnapshot(value: unknown): value is EditorStateSnapshot {
  if (
    !record(value, [
      'relativePath',
      'languageId',
      'documentVersion',
      'dirty',
      'selection',
      'diagnostics',
      'capturedAt',
    ])
  )
    return false
  if (
    typeof value.relativePath !== 'string' ||
    value.relativePath.length > 1024 ||
    !isCanonicalWorkspaceRelativePath(value.relativePath)
  )
    return false
  if (typeof value.languageId !== 'string' || !/^[\w.+-]{1,64}$/u.test(value.languageId)) return false
  if (!integer(value.documentVersion, 1) || typeof value.dirty !== 'boolean') return false
  const selection = value.selection
  if (!record(selection, ['start', 'end']) || !position(selection.start) || !position(selection.end))
    return false
  if (
    selection.start.line > selection.end.line ||
    (selection.start.line === selection.end.line && selection.start.column > selection.end.column)
  )
    return false
  if (
    !record(value.diagnostics, ['errors', 'warnings']) ||
    !integer(value.diagnostics.errors) ||
    !integer(value.diagnostics.warnings)
  )
    return false
  return (
    typeof value.capturedAt === 'string' &&
    value.capturedAt.length === 24 &&
    Number.isFinite(Date.parse(value.capturedAt)) &&
    new Date(value.capturedAt).toISOString() === value.capturedAt
  )
}
export function isEditorBridgeFailure(value: unknown): value is EditorBridgeFailure {
  return typeof value === 'string' && EDITOR_BRIDGE_FAILURES.some((reason) => reason === value)
}
export function isEditorBridgeReply(value: unknown): value is EditorBridgeReply {
  return (
    (record(value, ['ok', 'snapshot']) && value.ok === true && isEditorStateSnapshot(value.snapshot)) ||
    (record(value, ['ok', 'reason']) && value.ok === false && isEditorBridgeFailure(value.reason))
  )
}
export function isEditorBridgeBinding(value: unknown): value is EditorBridgeBinding {
  return (
    record(value, ['bindingId', 'protocolVersion']) &&
    isEditorBridgeId(value.bindingId) &&
    value.protocolVersion === EDITOR_BRIDGE_PROTOCOL
  )
}
export function isEditorBridgeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/u.test(value)
}
export function isEditorBridgePoll(value: unknown): value is EditorBridgePoll {
  return (
    (record(value, ['kind']) && value.kind === 'idle') ||
    (record(value, ['kind', 'requestId']) && value.kind === 'request' && isEditorBridgeId(value.requestId))
  )
}
