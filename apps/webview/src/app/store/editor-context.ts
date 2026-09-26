import {
  isCanonicalWorkspaceRelativePath,
  isPromptTemplateVariable,
  isValidEditorContextRange,
  type EditorContextItem,
  type EditorContextKind,
  type PromptAttachment,
  type PromptTemplateVariable,
} from '@dsh-vscode/domain'
import { translate } from '../../i18n.js'
import { optionalGeneration, optionalString } from './scalars.js'
import type { OpenFileCandidate } from './types.js'
import { object } from './unknown-record.js'

export function promptTemplateVariables(values: readonly string[]): PromptTemplateVariable[] {
  if (values.some((value) => !isPromptTemplateVariable(value)))
    throw new Error(translate('app.error.promptTemplate'))
  return values.map((value) => value as PromptTemplateVariable)
}

export function parseEditorContextItems(value: unknown): readonly EditorContextItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.map(parseEditorContextItem)
  return items.every((item): item is EditorContextItem => item !== undefined) ? items : undefined
}

export function parseEditorContextAvailableKinds(value: unknown): readonly EditorContextKind[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const kinds = value.map((entry: unknown): EditorContextKind | undefined => {
    if (entry === 'open-document') return 'file'
    if (entry === 'selection' || entry === 'diagnostic' || entry === 'symbol') return entry
    return undefined
  })
  return kinds.every((kind): kind is EditorContextKind => kind !== undefined)
    ? [...new Set(kinds)]
    : undefined
}

export function parseEditorContextItem(value: unknown): EditorContextItem | undefined {
  const item = object(value)
  const scope = object(item?.scope)
  if (
    item === undefined ||
    scope === undefined ||
    typeof item.contextRef !== 'string' ||
    typeof item.kind !== 'string' ||
    typeof item.label !== 'string' ||
    typeof item.workspaceFolderId !== 'string' ||
    typeof item.relativePath !== 'string' ||
    !isCanonicalWorkspaceRelativePath(item.relativePath) ||
    !['selection', 'open-document', 'diagnostic', 'symbol'].includes(item.kind) ||
    typeof item.sizeBytes !== 'number' ||
    !Number.isSafeInteger(item.sizeBytes) ||
    item.sizeBytes < 0 ||
    typeof item.stale !== 'boolean' ||
    typeof item.previewAvailable !== 'boolean' ||
    typeof item.expiresAt !== 'number' ||
    !Number.isSafeInteger(item.expiresAt) ||
    typeof scope.ownerId !== 'string' ||
    typeof scope.workspaceFolderId !== 'string' ||
    scope.workspaceFolderId !== item.workspaceFolderId ||
    typeof scope.ownerViewId !== 'string' ||
    typeof scope.expiresAt !== 'number' ||
    scope.expiresAt !== item.expiresAt
  )
    return undefined
  const range = parseEditorContextRange(item.range)
  if (item.range !== undefined && range === undefined) return undefined
  const kind = item.kind === 'open-document' ? 'file' : item.kind
  if (kind !== 'selection' && kind !== 'file' && kind !== 'diagnostic' && kind !== 'symbol') return undefined
  const sessionId = optionalString(scope.sessionId)
  const backendInstanceId = optionalString(scope.backendInstanceId)
  const connectionGeneration = optionalGeneration(scope.connectionGeneration)
  const documentVersion = optionalGeneration(item.documentVersion)
  return {
    ref: {
      contextRef: item.contextRef,
      kind,
      workspaceFolderId: item.workspaceFolderId,
      ownerId: scope.ownerId,
      ownerViewId: scope.ownerViewId,
      contextStoreGeneration: 1,
      relativePath: item.relativePath,
      ...(range === undefined ? {} : { range }),
      sizeBytes: item.sizeBytes,
      capturedAt: item.expiresAt,
      ...(documentVersion === undefined ? {} : { documentVersion }),
      contentHash: '',
      expiresAt: item.expiresAt,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(backendInstanceId === undefined ? {} : { backendInstanceId }),
      ...(connectionGeneration === undefined ? {} : { connectionGeneration }),
    },
    label: item.label,
    stale: item.stale,
    previewAvailable: item.previewAvailable,
  }
}

export function parseEditorContextRange(value: unknown): EditorContextItem['ref']['range'] {
  if (value === undefined) return undefined
  const range = object(value)
  const start = object(range?.start)
  const end = object(range?.end)
  if (
    start === undefined ||
    end === undefined ||
    typeof start.line !== 'number' ||
    typeof start.column !== 'number' ||
    typeof end.line !== 'number' ||
    typeof end.column !== 'number'
  )
    return undefined
  const parsed = {
    start: { line: start.line, column: start.column },
    end: { line: end.line, column: end.column },
  }
  return isValidEditorContextRange(parsed) ? parsed : undefined
}

export function mergeEditorContext(
  current: readonly EditorContextItem[],
  next: readonly EditorContextItem[],
): readonly EditorContextItem[] {
  const byRef = new Map(current.map((item) => [item.ref.contextRef, item]))
  for (const item of next) byRef.set(item.ref.contextRef, item)
  return [...byRef.values()].sort((left, right) => right.ref.capturedAt - left.ref.capturedAt)
}

export function attachmentFromResult(resultValue: unknown): PromptAttachment | undefined {
  const result = object(resultValue)
  const attachment = object(result?.attachment)
  if (
    result?.cancelled === true ||
    attachment === undefined ||
    typeof attachment.uri !== 'string' ||
    typeof attachment.name !== 'string'
  )
    return undefined
  return {
    uri: attachment.uri,
    name: attachment.name,
    ...(typeof attachment.mimeType === 'string' ? { mimeType: attachment.mimeType } : {}),
  }
}

export function imageDataUri(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const uri = value.trim()
  return /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/u.test(uri) ? uri : undefined
}

export function openFileCandidatesFromResult(resultValue: unknown): readonly OpenFileCandidate[] {
  const result = object(resultValue)
  if (!Array.isArray(result?.items)) return []
  return result.items.flatMap((value): OpenFileCandidate[] => {
    const item = object(value)
    if (
      item === undefined ||
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.active !== 'boolean' ||
      typeof item.supported !== 'boolean'
    )
      return []
    return [
      {
        id: item.id,
        name: item.name,
        ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}),
        active: item.active,
        supported: item.supported,
      },
    ]
  })
}
