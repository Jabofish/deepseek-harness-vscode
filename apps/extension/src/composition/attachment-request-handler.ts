import * as vscode from 'vscode'
import path from 'node:path'
import { AppError } from '@dsh-vscode/domain'
import type { WebviewRequest } from '@dsh-vscode/webview-protocol'
import {
  decodeCanonicalBase64,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  type StoredAttachmentInput,
} from '../attachments/attachment-store.js'
import {
  attachmentMimeType,
  isImageMimeType,
  prepareAttachment,
  isAttachmentSupported,
  assertAttachmentSupported,
  validImageBytes,
} from '../attachments/attachment-codec.js'
import { featureContextItem, listOpenFileCandidates, readOpenFileAttachment } from './editor-files.js'
import type { RequestGatewayDependencies } from './request-gateway-dependencies.js'
import { unsupportedRequest } from './request-routing.js'

type AttachmentRequest = Extract<WebviewRequest, { type: `attachment.${string}` }>
type AttachmentDependencies = Pick<
  RequestGatewayDependencies,
  | 'backendService'
  | 'sessionUseCases'
  | 'attachmentTokens'
  | 'editorContextProvider'
  | 'requireCurrentWorkspaceSession'
>

export function isAttachmentRequest(request: WebviewRequest): request is AttachmentRequest {
  return request.type.startsWith('attachment.')
}

export function createAttachmentRequestHandler(
  deps: AttachmentDependencies,
): (request: AttachmentRequest, signal: AbortSignal) => Promise<unknown> {
  const {
    backendService,
    sessionUseCases,
    attachmentTokens,
    editorContextProvider,
    requireCurrentWorkspaceSession,
  } = deps

  const supportsBinaryAttachments = (): boolean => {
    try {
      return backendService.requireBackend().sessions.supportsFileUploads === true
    } catch {
      return false
    }
  }

  const rememberSupportedAttachment = (
    input: StoredAttachmentInput,
  ): ReturnType<typeof attachmentTokens.remember> => {
    assertAttachmentSupported(input, supportsBinaryAttachments())
    return attachmentTokens.remember(input)
  }
  return async (request: AttachmentRequest, signal: AbortSignal): Promise<unknown> => {
    if (request.type === 'attachment.pick') {
      signal.throwIfAborted()
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Attach file',
      })
      const uri = selected?.[0]
      signal.throwIfAborted()
      if (uri === undefined) return { cancelled: true }
      const info = await vscode.workspace.fs.stat(uri)
      signal.throwIfAborted()
      if (
        (info.type & vscode.FileType.File) === 0 ||
        (info.type & vscode.FileType.SymbolicLink) !== 0 ||
        info.size > MAX_IMAGE_ATTACHMENT_BYTES
      )
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The selected file is too large or is not a regular file.',
          retryable: false,
        })
      const bytes = Buffer.from(await vscode.workspace.fs.readFile(uri))
      signal.throwIfAborted()
      if (bytes.length > MAX_IMAGE_ATTACHMENT_BYTES)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The selected file is too large.',
          retryable: false,
        })
      const mimeType = attachmentMimeType(uri.path, bytes)
      if (mimeType === undefined)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The selected file contents do not match its declared text type.',
          retryable: false,
        })
      const maximumBytes = isImageMimeType(mimeType) ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES
      if (bytes.length > maximumBytes)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The selected file is too large.',
          retryable: false,
        })
      if (isImageMimeType(mimeType) && !validImageBytes(mimeType, bytes))
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The selected file contents do not match its declared image type.',
          retryable: false,
        })
      return {
        cancelled: false,
        attachment: rememberSupportedAttachment({
          name: path.posix.basename(uri.path),
          mimeType,
          dataUri: `data:${mimeType};base64,${bytes.toString('base64')}`,
        }),
      }
    }

    if (request.type === 'attachment.ingest') {
      const { name, mimeType, dataBase64 } = request.payload
      const bytes = decodeCanonicalBase64(dataBase64, MAX_IMAGE_ATTACHMENT_BYTES)
      return {
        cancelled: false,
        // decodeCanonicalBase64 validated dataBase64 as the canonical encoding
        // of bytes; pass it through so the data URI skips a full re-encode.
        attachment: rememberSupportedAttachment(
          prepareAttachment(name, bytes, mimeType, bytes === undefined ? undefined : dataBase64),
        ),
      }
    }

    if (request.type === 'attachment.preview') {
      const dataUri = attachmentTokens.preview(request.payload.uri)
      return dataUri === undefined ? { cancelled: true } : { cancelled: false, dataUri }
    }

    if (request.type === 'attachment.release') {
      attachmentTokens.releaseUris(request.payload.uris)
      return undefined
    }

    if (request.type === 'attachment.open.list') {
      const candidates = listOpenFileCandidates()
      return {
        items: candidates.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          ...(candidate.mimeType === undefined ? {} : { mimeType: candidate.mimeType }),
          active: candidate.active,
          supported: isAttachmentSupported(candidate.mimeType, supportsBinaryAttachments()),
        })),
      }
    }

    if (request.type === 'attachment.open.attach') {
      const candidate = listOpenFileCandidates().find((item) => item.id === request.payload.candidateId)
      if (candidate === undefined || !isAttachmentSupported(candidate.mimeType, supportsBinaryAttachments()))
        return { cancelled: true }
      const attachment = await readOpenFileAttachment(candidate)
      if (attachment === undefined) return { cancelled: true }
      if (
        candidate.uri.scheme === 'file' &&
        attachment.mimeType !== undefined &&
        attachment.mimeType !== 'application/octet-stream' &&
        !isImageMimeType(attachment.mimeType)
      ) {
        const context = await editorContextProvider
          .captureOpenFile(candidate.uri, signal)
          .catch((error: unknown) => {
            if (error instanceof AppError && error.code === 'CONTEXT_LIMIT') return undefined
            throw error
          })
        if (context !== undefined) return { kind: 'editor.context', items: [featureContextItem(context)] }
      }
      return {
        cancelled: false,
        attachment: rememberSupportedAttachment(attachment),
      }
    }

    if (request.type === 'attachment.read') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const attachment = await sessionUseCases.readAttachment(
        request.payload.sessionId,
        request.payload.attachmentId,
        signal,
      )
      return {
        cancelled: false,
        attachment: {
          name: attachment.name,
          ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
        },
        // The adapter has already validated this as a bounded image data URI.
        // It is display data, not an endpoint or credential, so historical
        // images do not need a second opaque-handle round trip.
        dataUri: attachment.uri,
      }
    }
    return unsupportedRequest(request)
  }
}
