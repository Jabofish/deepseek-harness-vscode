import { isCanonicalWorkspaceRelativePath } from './feature-contracts.js'
import { isEditorBridgeId, isEditorStateSnapshot, type EditorStateSnapshot } from './editor-bridge.js'

export const EDITOR_COMPANION_PROTOCOL = 2
export const EDITOR_COMPANION_TOOLS = {
  vscode_get_editor_state: 'state',
  vscode_read_document: 'document',
  vscode_read_selection: 'selection',
  vscode_get_diagnostics: 'diagnostics',
  vscode_find_symbols: 'symbols',
  vscode_find_definitions: 'definitions',
  vscode_find_references: 'references',
  vscode_open_file: 'open',
  vscode_propose_edit: 'propose',
  vscode_get_edit_result: 'proposal',
} as const
export const EDITOR_COMPANION_CAPABILITIES = [
  'content',
  'diagnostics',
  'language',
  'navigation',
  'edit',
] as const
export type EditorCompanionCapability = (typeof EDITOR_COMPANION_CAPABILITIES)[number]
export const EDITOR_COMPANION_FAILURES = [
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
  'denied',
  'unsupported',
  'stale-document',
  'not-found',
  'file-access',
  'invalid-range',
  'limit',
] as const
export type EditorCompanionFailure = (typeof EDITOR_COMPANION_FAILURES)[number]
export class EditorCompanionError extends Error {
  public constructor(public readonly reason: EditorCompanionFailure) {
    super(`Editor companion request failed (${reason}).`)
    this.name = 'EditorCompanionError'
  }
}
export const EDITOR_COMPANION_LIMITS = {
  text: 65_536,
  documentText: 16_384,
  documentLines: 200,
  items: 200,
  edits: 64,
  grants: 16,
  requests: 4,
} as const
export interface EditorPosition {
  readonly line: number
  readonly column: number
}
export interface EditorRange {
  readonly start: EditorPosition
  readonly end: EditorPosition
}
export interface EditorTextEdit {
  readonly range: EditorRange
  readonly text: string
}
interface DocumentTarget {
  readonly path?: string
}
export type EditorCompanionRequest =
  | { readonly kind: 'state' }
  | ({
      readonly kind: 'document'
      readonly startLine?: number
      readonly startColumn?: number
      readonly endLine?: number
      readonly expectedVersion?: number
    } & DocumentTarget)
  | { readonly kind: 'selection' }
  | ({ readonly kind: 'diagnostics'; readonly limit?: number } & DocumentTarget)
  | ({ readonly kind: 'symbols'; readonly query?: string; readonly limit?: number } & DocumentTarget)
  | ({
      readonly kind: 'definitions' | 'references'
      readonly line: number
      readonly column: number
      readonly limit?: number
    } & DocumentTarget)
  | ({ readonly kind: 'open'; readonly line?: number; readonly column?: number } & DocumentTarget)
  | {
      readonly kind: 'propose'
      readonly path: string
      readonly expectedVersion: number
      readonly edits: readonly EditorTextEdit[]
    }
  | { readonly kind: 'proposal'; readonly proposalId: string }
export type EditorProposalStatus =
  'pending' | 'applied' | 'uncertain' | 'reverted' | 'declined' | 'stale' | 'cancelled'
export interface EditorLocation {
  readonly relativePath: string
  readonly range: EditorRange
}
export interface EditorSymbolLocation extends EditorLocation {
  readonly name: string
  readonly symbolKind: number
  readonly container: string
}
export interface EditorDiagnostic {
  readonly range: EditorRange
  readonly severity: 'error' | 'warning' | 'information' | 'hint'
  readonly message: string
  readonly source: string
  readonly code: string
}
export type EditorCompanionValue =
  | { readonly kind: 'state'; readonly state: EditorStateSnapshot }
  | {
      readonly kind: 'document'
      readonly relativePath: string
      readonly languageId: string
      readonly version: number
      readonly dirty: boolean
      readonly range: EditorRange
      readonly text: string
      readonly truncated: boolean
    }
  | {
      readonly kind: 'diagnostics'
      readonly relativePath: string
      readonly version: number
      readonly capturedAt: string
      readonly cached: true
      readonly items: readonly EditorDiagnostic[]
      readonly truncated: boolean
    }
  | {
      readonly kind: 'symbols'
      readonly items: readonly EditorSymbolLocation[]
      readonly truncated: boolean
      readonly excluded: number
    }
  | {
      readonly kind: 'locations'
      readonly items: readonly EditorLocation[]
      readonly truncated: boolean
      readonly excluded: number
    }
  | { readonly kind: 'opened'; readonly relativePath: string }
  | {
      readonly kind: 'proposal'
      readonly proposalId: string
      readonly relativePath: string
      readonly status: EditorProposalStatus
      readonly version: number
      /** Save outcome at receipt creation; false still means an applied buffer edit. */
      readonly saved?: boolean
    }
export type EditorCompanionReply =
  | { readonly ok: true; readonly value: EditorCompanionValue }
  | { readonly ok: false; readonly reason: EditorCompanionFailure }
export type EditorCompanionResult<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'error'; readonly reason: EditorCompanionFailure }
export interface EditorCompanionDescription {
  readonly protocolVersion: 2
  readonly packageVersion: string
  readonly capabilities: readonly EditorCompanionCapability[]
  readonly maxGrants: number
}
export interface EditorCompanionBinding {
  readonly bindingId: string
  readonly protocolVersion: 2
}
export interface EditorCompanionHostProof {
  readonly proof: string
}
export type EditorCompanionPoll =
  | { readonly kind: 'idle' }
  | { readonly kind: 'request'; readonly requestId: string; readonly request: EditorCompanionRequest }
  | { readonly kind: 'cancel'; readonly requestId: string }
export interface EditorCompanionRepository {
  /** Optional extension-bundled build identity; older companions do not advertise it. */
  buildIdentity?(signal?: AbortSignal): Promise<string>
  describe(signal?: AbortSignal): Promise<EditorCompanionDescription>
  verifyHost(nonce: string, signal?: AbortSignal): Promise<EditorCompanionHostProof>
  attach(
    sessionId: string,
    ownerId: string,
    capabilities: readonly EditorCompanionCapability[],
    signal?: AbortSignal,
  ): Promise<EditorCompanionBinding>
  poll(bindingId: string, signal?: AbortSignal): Promise<EditorCompanionPoll>
  respond(
    bindingId: string,
    requestId: string,
    reply: EditorCompanionReply,
    signal?: AbortSignal,
  ): Promise<void>
  detach(bindingId: string, signal?: AbortSignal): Promise<void>
}
export interface EditorCompanionPort {
  execute(request: EditorCompanionRequest, signal: AbortSignal): Promise<EditorCompanionValue>
}
export function editorCapability(request: EditorCompanionRequest): EditorCompanionCapability | undefined {
  switch (request.kind) {
    case 'state':
      return undefined
    case 'document':
    case 'selection':
      return 'content'
    case 'diagnostics':
      return 'diagnostics'
    case 'symbols':
    case 'definitions':
    case 'references':
      return 'language'
    case 'open':
      return 'navigation'
    case 'propose':
    case 'proposal':
      return 'edit'
  }
}
function shape(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  )
}
function int(value: unknown, min = 0, max = 1_000_000_000): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
function text(value: unknown, max: number, min = 0): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
}
function relative(value: unknown): value is string {
  return text(value, 1024, 1) && isCanonicalWorkspaceRelativePath(value)
}
function optional(
  value: Record<string, unknown>,
  key: string,
  accepts: (value: unknown) => boolean,
): boolean {
  return !Object.hasOwn(value, key) || accepts(value[key])
}
function target(value: Record<string, unknown>): boolean {
  return optional(value, 'path', relative)
}
function limit(value: Record<string, unknown>): boolean {
  return optional(value, 'limit', (value) => int(value, 1, EDITOR_COMPANION_LIMITS.items))
}
function position(value: unknown): value is EditorPosition {
  return shape(value, ['line', 'column']) && int(value.line, 1) && int(value.column, 1)
}
export function isEditorRange(value: unknown): value is EditorRange {
  return (
    shape(value, ['start', 'end']) &&
    position(value.start) &&
    position(value.end) &&
    (value.start.line < value.end.line ||
      (value.start.line === value.end.line && value.start.column <= value.end.column))
  )
}
export function isEditorCompanionCapabilities(value: unknown): value is readonly EditorCompanionCapability[] {
  return (
    Array.isArray(value) &&
    value.length <= EDITOR_COMPANION_CAPABILITIES.length &&
    new Set(value).size === value.length &&
    value.every((item) => EDITOR_COMPANION_CAPABILITIES.some((capability) => capability === item))
  )
}
export function isEditorCompanionRequest(value: unknown): value is EditorCompanionRequest {
  if (
    !shape(
      value,
      ['kind'],
      [
        'path',
        'startLine',
        'startColumn',
        'endLine',
        'expectedVersion',
        'limit',
        'query',
        'line',
        'column',
        'edits',
        'proposalId',
      ],
    )
  )
    return false
  switch (value.kind) {
    case 'state':
    case 'selection':
      return shape(value, ['kind'])
    case 'document':
      return (
        shape(value, ['kind'], ['path', 'startLine', 'startColumn', 'endLine', 'expectedVersion']) &&
        target(value) &&
        // Line ranges are clamped by the Host, so zero-based or inverted input stays usable.
        optional(value, 'startLine', (value) => int(value, 0)) &&
        optional(value, 'startColumn', (value) => int(value, 1)) &&
        optional(value, 'endLine', (value) => int(value, 0)) &&
        optional(value, 'expectedVersion', (value) => int(value, 1))
      )
    case 'diagnostics':
      return shape(value, ['kind'], ['path', 'limit']) && target(value) && limit(value)
    case 'symbols':
      return (
        shape(value, ['kind'], ['path', 'query', 'limit']) &&
        target(value) &&
        limit(value) &&
        optional(value, 'query', (value) => text(value, 256, 1))
      )
    case 'definitions':
    case 'references':
      return (
        shape(value, ['kind', 'line', 'column'], ['path', 'limit']) &&
        target(value) &&
        limit(value) &&
        int(value.line, 1) &&
        int(value.column, 1)
      )
    case 'open':
      return (
        shape(value, ['kind'], ['path', 'line', 'column']) &&
        target(value) &&
        optional(value, 'line', (value) => int(value, 1)) &&
        optional(value, 'column', (value) => int(value, 1))
      )
    case 'propose':
      return (
        shape(value, ['kind', 'path', 'expectedVersion', 'edits']) &&
        relative(value.path) &&
        int(value.expectedVersion, 1) &&
        Array.isArray(value.edits) &&
        value.edits.length > 0 &&
        value.edits.length <= EDITOR_COMPANION_LIMITS.edits &&
        value.edits.every(
          (edit) =>
            shape(edit, ['range', 'text']) &&
            isEditorRange(edit.range) &&
            text(edit.text, EDITOR_COMPANION_LIMITS.text),
        ) &&
        value.edits.reduce<number>((size, edit: EditorTextEdit) => size + edit.text.length, 0) <=
          EDITOR_COMPANION_LIMITS.text
      )
    case 'proposal':
      return shape(value, ['kind', 'proposalId']) && isEditorBridgeId(value.proposalId)
    default:
      return false
  }
}
function location(value: unknown): value is EditorLocation {
  return shape(value, ['relativePath', 'range']) && relative(value.relativePath) && isEditorRange(value.range)
}
function symbol(value: unknown): value is EditorSymbolLocation {
  return (
    shape(value, ['relativePath', 'range', 'name', 'symbolKind', 'container']) &&
    relative(value.relativePath) &&
    isEditorRange(value.range) &&
    text(value.name, 512) &&
    int(value.symbolKind, 0, 25) &&
    text(value.container, 512)
  )
}
function diagnostic(value: unknown): value is EditorDiagnostic {
  return (
    shape(value, ['range', 'severity', 'message', 'source', 'code']) &&
    isEditorRange(value.range) &&
    ['error', 'warning', 'information', 'hint'].includes(String(value.severity)) &&
    text(value.message, 2000) &&
    text(value.source, 128) &&
    text(value.code, 128)
  )
}
function items(value: unknown, accepts: (value: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length <= EDITOR_COMPANION_LIMITS.items && value.every(accepts)
}
export function isEditorCompanionValue(value: unknown): value is EditorCompanionValue {
  if (
    !shape(
      value,
      ['kind'],
      [
        'state',
        'relativePath',
        'languageId',
        'version',
        'dirty',
        'range',
        'text',
        'truncated',
        'capturedAt',
        'cached',
        'items',
        'excluded',
        'proposalId',
        'status',
        'saved',
      ],
    )
  )
    return false
  switch (value.kind) {
    case 'state':
      return shape(value, ['kind', 'state']) && isEditorStateSnapshot(value.state)
    case 'document':
      return (
        shape(value, [
          'kind',
          'relativePath',
          'languageId',
          'version',
          'dirty',
          'range',
          'text',
          'truncated',
        ]) &&
        relative(value.relativePath) &&
        text(value.languageId, 64, 1) &&
        int(value.version, 1) &&
        typeof value.dirty === 'boolean' &&
        isEditorRange(value.range) &&
        text(value.text, EDITOR_COMPANION_LIMITS.text) &&
        typeof value.truncated === 'boolean'
      )
    case 'diagnostics':
      return (
        shape(value, ['kind', 'relativePath', 'version', 'capturedAt', 'cached', 'items', 'truncated']) &&
        relative(value.relativePath) &&
        int(value.version, 1) &&
        text(value.capturedAt, 24, 24) &&
        Number.isFinite(Date.parse(value.capturedAt)) &&
        value.cached === true &&
        items(value.items, diagnostic) &&
        typeof value.truncated === 'boolean'
      )
    case 'symbols':
    case 'locations':
      return (
        shape(value, ['kind', 'items', 'truncated', 'excluded']) &&
        items(value.items, value.kind === 'symbols' ? symbol : location) &&
        typeof value.truncated === 'boolean' &&
        int(value.excluded)
      )
    case 'opened':
      return shape(value, ['kind', 'relativePath']) && relative(value.relativePath)
    case 'proposal':
      return (
        shape(value, ['kind', 'proposalId', 'relativePath', 'status', 'version'], ['saved']) &&
        isEditorBridgeId(value.proposalId) &&
        relative(value.relativePath) &&
        ['pending', 'applied', 'uncertain', 'reverted', 'declined', 'stale', 'cancelled'].includes(
          String(value.status),
        ) &&
        int(value.version, 1) &&
        optional(value, 'saved', (saved) => typeof saved === 'boolean')
      )
    default:
      return false
  }
}
export function editorValueMatches(request: EditorCompanionRequest, value: EditorCompanionValue): boolean {
  const kind =
    request.kind === 'selection'
      ? 'document'
      : request.kind === 'definitions' || request.kind === 'references'
        ? 'locations'
        : request.kind === 'open'
          ? 'opened'
          : request.kind === 'propose'
            ? 'proposal'
            : request.kind
  if (kind !== value.kind) return false
  if (
    'path' in request &&
    request.path !== undefined &&
    'relativePath' in value &&
    request.path !== value.relativePath
  )
    return false
  if (request.kind === 'proposal' && value.kind === 'proposal' && request.proposalId !== value.proposalId)
    return false
  if (
    request.kind === 'propose' &&
    value.kind === 'proposal' &&
    !(
      (value.status === 'pending' && value.version === request.expectedVersion) ||
      (['applied', 'uncertain', 'stale', 'cancelled'].includes(value.status) &&
        value.version >= request.expectedVersion)
    )
  )
    return false
  if (
    request.kind === 'document' &&
    request.expectedVersion !== undefined &&
    value.kind === 'document' &&
    request.expectedVersion !== value.version
  )
    return false
  return true
}
export function isEditorCompanionFailure(value: unknown): value is EditorCompanionFailure {
  return EDITOR_COMPANION_FAILURES.some((reason) => reason === value)
}
export function isEditorCompanionReply(value: unknown): value is EditorCompanionReply {
  return (
    (shape(value, ['ok', 'value']) && value.ok === true && isEditorCompanionValue(value.value)) ||
    (shape(value, ['ok', 'reason']) && value.ok === false && isEditorCompanionFailure(value.reason))
  )
}
export function isEditorCompanionResult<T>(
  value: unknown,
  accepts: (value: unknown) => value is T,
): value is EditorCompanionResult<T> {
  return (
    (shape(value, ['status', 'value']) && value.status === 'ok' && accepts(value.value)) ||
    (shape(value, ['status', 'reason']) && value.status === 'error' && isEditorCompanionFailure(value.reason))
  )
}
export function isEditorCompanionDescription(value: unknown): value is EditorCompanionDescription {
  return (
    shape(value, ['protocolVersion', 'packageVersion', 'capabilities', 'maxGrants']) &&
    value.protocolVersion === 2 &&
    text(value.packageVersion, 64, 1) &&
    /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(value.packageVersion) &&
    isEditorCompanionCapabilities(value.capabilities) &&
    int(value.maxGrants, 1, 64)
  )
}
export function isEditorCompanionBinding(value: unknown): value is EditorCompanionBinding {
  return (
    shape(value, ['bindingId', 'protocolVersion']) &&
    value.protocolVersion === 2 &&
    isEditorBridgeId(value.bindingId)
  )
}
export function isEditorCompanionHostProof(value: unknown): value is EditorCompanionHostProof {
  return shape(value, ['proof']) && typeof value.proof === 'string' && /^[a-f0-9]{64}$/u.test(value.proof)
}
export function isEditorCompanionPoll(value: unknown): value is EditorCompanionPoll {
  return (
    (shape(value, ['kind']) && value.kind === 'idle') ||
    (shape(value, ['kind', 'requestId']) && value.kind === 'cancel' && isEditorBridgeId(value.requestId)) ||
    (shape(value, ['kind', 'requestId', 'request']) &&
      value.kind === 'request' &&
      isEditorBridgeId(value.requestId) &&
      isEditorCompanionRequest(value.request))
  )
}
