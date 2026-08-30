import type { PromptAttachment } from './sessions.js'

export type EditorContextKind = 'selection' | 'file' | 'diagnostic' | 'symbol'

/**
 * Capabilities projected by the host for the currently active editor.
 *
 * The Webview must not infer these from whether a button happens to render:
 * an action is shown only when the host says that capture can succeed now.
 */
export interface EditorContextAvailability {
  readonly availableKinds: readonly EditorContextKind[]
}

export interface EditorContextPosition {
  readonly line: number
  readonly column: number
}

export interface EditorContextRange {
  readonly start: EditorContextPosition
  readonly end: EditorContextPosition
}

export interface EditorContextLimits {
  readonly maxItems: number
  readonly maxItemBytes: number
  readonly maxTotalBytes: number
  readonly maxPreviewBytes: number
  readonly ttlMs: number
}

export const EDITOR_CONTEXT_LIMITS: EditorContextLimits = {
  maxItems: 8,
  maxItemBytes: 64 * 1024,
  maxTotalBytes: 256 * 1024,
  maxPreviewBytes: 32 * 1024,
  ttlMs: 10 * 60 * 1000,
}

export interface EditorContextRef {
  readonly contextRef: string
  readonly workspaceFolderId: string
  readonly ownerId: string
  readonly ownerViewId: string
  readonly contextStoreGeneration: number
  readonly sessionId?: string
  readonly backendInstanceId?: string
  readonly connectionGeneration?: number
  readonly kind: EditorContextKind
  readonly relativePath: string
  readonly range?: EditorContextRange
  readonly sizeBytes: number
  readonly capturedAt: number
  readonly documentVersion?: number
  readonly contentHash: string
  readonly expiresAt: number
}

export interface EditorContextItem {
  readonly ref: EditorContextRef
  readonly label: string
  readonly stale: boolean
  readonly previewAvailable: boolean
}

export interface EditorContextCaptureInput {
  readonly kind: EditorContextKind
  readonly workspaceFolderId?: string
}

export interface EditorContextOwner {
  readonly ownerId: string
  readonly ownerViewId: string
  readonly workspaceFolderId?: string
  readonly contextStoreGeneration: number
}

export interface EditorContextSessionBinding {
  readonly sessionId: string
  readonly backendInstanceId: string
  readonly connectionGeneration: number
}

export interface EditorContextResolveInput extends EditorContextOwner, EditorContextSessionBinding {
  readonly contextRefs: readonly string[]
}

export interface EditorContextPreview {
  readonly contextRef: string
  readonly text: string
  readonly truncated: boolean
  readonly expiresAt: number
}

export interface ResolvedEditorContext {
  readonly contextRef: string
  readonly attachment: PromptAttachment
  readonly contentHash: string
  readonly sizeBytes: number
}

export function isValidEditorContextPosition(value: EditorContextPosition): boolean {
  return (
    Number.isSafeInteger(value.line) &&
    value.line >= 0 &&
    Number.isSafeInteger(value.column) &&
    value.column >= 0
  )
}

export function isValidEditorContextRange(value: EditorContextRange): boolean {
  if (!isValidEditorContextPosition(value.start) || !isValidEditorContextPosition(value.end)) return false
  return (
    value.start.line < value.end.line ||
    (value.start.line === value.end.line && value.start.column <= value.end.column)
  )
}

export function editorContextTotalBytes(items: readonly Pick<EditorContextRef, 'sizeBytes'>[]): number {
  return items.reduce((total, item) => total + item.sizeBytes, 0)
}

export function editorContextWithinLimits(
  items: readonly Pick<EditorContextRef, 'sizeBytes'>[],
  limits: EditorContextLimits = EDITOR_CONTEXT_LIMITS,
): boolean {
  return (
    items.length <= limits.maxItems &&
    items.every(
      (item) =>
        Number.isSafeInteger(item.sizeBytes) && item.sizeBytes >= 0 && item.sizeBytes <= limits.maxItemBytes,
    ) &&
    editorContextTotalBytes(items) <= limits.maxTotalBytes
  )
}
