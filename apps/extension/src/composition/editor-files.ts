import * as vscode from 'vscode'
import { createHash } from 'node:crypto'
import { stat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { type EditorContextAvailability, type EditorContextItem } from '@dsh-vscode/domain'
import { type StoredAttachmentInput } from '../attachments/attachment-store.js'
import { attachmentMimeType, prepareAttachment, readAttachmentFile } from '../attachments/attachment-codec.js'

export type FeatureContextKind = 'selection' | 'open-document' | 'diagnostic' | 'symbol'
export interface OpenFileCandidate {
  readonly id: string
  readonly uri: vscode.Uri
  readonly name: string
  readonly mimeType?: string
  readonly active: boolean
}

export function listOpenFileCandidates(): readonly OpenFileCandidate[] {
  const activeEditor = vscode.window.activeTextEditor
  const activeTabUri = currentTabUri(vscode.window.tabGroups.activeTabGroup.activeTab?.input)
  const activeUri = activeEditor?.document.uri.toString() ?? activeTabUri?.toString()
  const seen = new Set<string>()
  const candidates: OpenFileCandidate[] = []
  const add = (uri: vscode.Uri): void => {
    if (!isOpenFileUri(uri)) return
    const uriKey = uri.toString()
    if (seen.has(uriKey)) return
    seen.add(uriKey)
    const document = openDocumentForUri(uri)
    const name = fileNameForUri(uri, document)
    const mimeType = attachmentMimeType(name, Buffer.alloc(0))
    candidates.push({
      id: openFileCandidateId(uri),
      uri,
      name,
      ...(mimeType === undefined ? {} : { mimeType }),
      active: uriKey === activeUri,
    })
  }

  for (const group of vscode.window.tabGroups.all)
    for (const tab of group.tabs) {
      for (const uri of tabInputUris(tab.input)) add(uri)
    }
  if (activeEditor !== undefined) add(activeEditor.document.uri)

  return candidates.sort((left, right) => Number(right.active) - Number(left.active))
}

export async function readOpenFileAttachment(
  candidate: OpenFileCandidate,
): Promise<StoredAttachmentInput | undefined> {
  const openDocument = openDocumentForUri(candidate.uri)
  if (openDocument !== undefined)
    return prepareAttachment(candidate.name, Buffer.from(openDocument.getText(), 'utf8'))
  if (candidate.uri.scheme !== 'file') return undefined
  return readAttachmentFile(candidate.name, candidate.uri.fsPath, { stat, readFile })
}

function openDocumentForUri(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
}

function isOpenFileUri(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' || uri.scheme === 'untitled'
}

function fileNameForUri(uri: vscode.Uri, document: vscode.TextDocument | undefined): string {
  const source = document?.fileName || (uri.scheme === 'file' ? uri.fsPath : uri.path)
  const name = path.basename(source)
  return name === '' || name === '.' || name === path.sep
    ? `Untitled-${document?.languageId || 'file'}`
    : name
}

function openFileCandidateId(uri: vscode.Uri): string {
  return `dsh-open-file-${createHash('sha256').update(uri.toString(), 'utf8').digest('hex').slice(0, 32)}`
}

function currentTabUri(input: vscode.Tab['input']): vscode.Uri | undefined {
  return tabInputUris(input)[0]
}

function tabInputUris(input: vscode.Tab['input']): readonly vscode.Uri[] {
  if (input instanceof vscode.TabInputText) return [input.uri]
  if (input instanceof vscode.TabInputTextDiff) return [input.modified, input.original]
  if (input instanceof vscode.TabInputCustom) return [input.uri]
  if (input instanceof vscode.TabInputNotebook) return [input.uri]
  if (input instanceof vscode.TabInputNotebookDiff) return [input.modified, input.original]
  return []
}
/** Project the domain ref into the flattened, schema-checked safe DTO. */
export function featureContextItem(item: EditorContextItem): unknown {
  const ref = item.ref
  return {
    contextRef: ref.contextRef,
    kind: ref.kind === 'file' ? 'open-document' : ref.kind,
    label: item.label,
    workspaceFolderId: ref.workspaceFolderId,
    relativePath: ref.relativePath,
    ...(ref.range === undefined ? {} : { range: ref.range }),
    sizeBytes: ref.sizeBytes,
    ...(ref.documentVersion === undefined ? {} : { documentVersion: ref.documentVersion }),
    stale: item.stale,
    previewAvailable: item.previewAvailable,
    expiresAt: ref.expiresAt,
    scope: {
      ownerId: ref.ownerId,
      workspaceFolderId: ref.workspaceFolderId,
      ownerViewId: ref.ownerViewId,
      ...(ref.sessionId === undefined ? {} : { sessionId: ref.sessionId }),
      ...(ref.backendInstanceId === undefined ? {} : { backendInstanceId: ref.backendInstanceId }),
      ...(ref.connectionGeneration === undefined ? {} : { connectionGeneration: ref.connectionGeneration }),
      expiresAt: ref.expiresAt,
    },
  }
}

export function featureContextKinds(availability: EditorContextAvailability): FeatureContextKind[] {
  return availability.availableKinds.map((kind) => (kind === 'file' ? 'open-document' : kind))
}
