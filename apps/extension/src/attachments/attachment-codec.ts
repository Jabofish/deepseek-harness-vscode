import { AppError } from '@dsh-vscode/domain'
import { isSupportedImageMimeType, matchesImageSignature } from '@dsh-vscode/dsh-adapter'

import {
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  type StoredAttachmentInput,
} from './attachment-store.js'

export interface AttachmentFileSystem {
  stat(path: string): Promise<{ isFile(): boolean; size: number }>
  readFile(path: string): Promise<Buffer>
}

/** Attachment byte budget for a file name, decided before any bytes are read. */
export function attachmentSizeLimit(name: string): number {
  return imageMimeType(name) === undefined ? MAX_ATTACHMENT_BYTES : MAX_IMAGE_ATTACHMENT_BYTES
}

/**
 * Read a file into an attachment only after its stat size proves it fits.
 * `prepareAttachment` enforces the same caps but only once the bytes are
 * already in memory, where it also UTF-8 decodes them for text sniffing, so an
 * oversized editor tab would be materialized in full before being rejected.
 */
export async function readAttachmentFile(
  name: string,
  filePath: string,
  fileSystem: AttachmentFileSystem,
): Promise<StoredAttachmentInput | undefined> {
  const info = await fileSystem.stat(filePath).catch(() => undefined)
  if (info === undefined || !info.isFile()) return undefined
  if (info.size > attachmentSizeLimit(name))
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The current file is too large to attach.',
      retryable: false,
    })
  return prepareAttachment(name, await fileSystem.readFile(filePath))
}

export function prepareAttachment(name: string, bytes: Buffer, hintMimeType?: string): StoredAttachmentInput {
  let mimeType = attachmentMimeType(name, bytes)
  // Pasted clipboard images often carry no filename extension. The declared
  // hint only fills that gap and is still verified against the image magic
  // numbers below, so a spoofed hint cannot smuggle unsupported bytes.
  if (mimeType === undefined && hintMimeType !== undefined && isImageMimeType(hintMimeType))
    mimeType = hintMimeType
  if (mimeType === undefined)
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The current file is not supported; attach an image or a text-based file instead.',
      retryable: false,
    })
  const maximumBytes = isImageMimeType(mimeType) ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES
  if (bytes.length > maximumBytes)
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The current file is too large to attach.',
      retryable: false,
    })
  if (isImageMimeType(mimeType) && !validImageBytes(mimeType, bytes))
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The current file contents do not match its declared image type.',
      retryable: false,
    })
  return {
    name,
    mimeType,
    dataUri: `data:${mimeType};base64,${bytes.toString('base64')}`,
  }
}

export function attachmentMimeType(filePath: string, bytes: Buffer): string | undefined {
  const imageType = imageMimeType(filePath)
  if (imageType !== undefined) return imageType

  const fileName = filePath.split(/[\\/]/u).pop()?.toLowerCase() ?? ''
  const extension = extensionName(fileName)
  if (BINARY_ATTACHMENT_EXTENSIONS.has(extension)) return undefined
  const knownTextType =
    TEXT_ATTACHMENT_MIME_TYPES[extension] ?? (fileName === '.env' ? 'text/plain' : undefined)
  if (knownTextType !== undefined) return validTextBytes(bytes) ? knownTextType : undefined
  return validTextBytes(bytes) ? 'text/plain' : undefined
}

export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/')
}

export function validImageBytes(mimeType: string, bytes: Buffer): boolean {
  return isSupportedImageMimeType(mimeType) && matchesImageSignature(mimeType, bytes)
}

function imageMimeType(filePath: string): string | undefined {
  switch (extensionName(filePath)) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    default:
      return undefined
  }
}

function validTextBytes(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false
  return !bytes.toString('utf8').includes('\ufffd')
}

function extensionName(value: string): string {
  const fileName = value.split(/[\\/]/u).pop() ?? value
  const dot = fileName.lastIndexOf('.')
  return dot <= 0 ? '' : fileName.slice(dot).toLowerCase()
}

const TEXT_ATTACHMENT_MIME_TYPES: Readonly<Record<string, string>> = {
  '.c': 'text/x-c',
  '.cc': 'text/x-c++',
  '.cpp': 'text/x-c++',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.go': 'text/x-go',
  '.h': 'text/x-c',
  '.hpp': 'text/x-c++',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.ini': 'text/plain',
  '.java': 'text/x-java-source',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.jsx': 'text/javascript',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.mjs': 'text/javascript',
  '.py': 'text/x-python',
  '.rs': 'text/x-rust',
  '.scss': 'text/x-scss',
  '.sh': 'application/x-sh',
  '.sql': 'application/sql',
  '.svelte': 'text/html',
  '.toml': 'application/toml',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.txt': 'text/plain',
  '.vue': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zsh': 'application/x-sh',
}

const BINARY_ATTACHMENT_EXTENSIONS = new Set([
  '.7z',
  '.avi',
  '.bin',
  '.bz2',
  '.dll',
  '.doc',
  '.docx',
  '.exe',
  '.flac',
  '.gz',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.mp3',
  '.mp4',
  '.mov',
  '.pdf',
  '.ppt',
  '.pptx',
  '.psd',
  '.rar',
  '.tar',
  '.ttf',
  '.wav',
  '.webm',
  '.woff',
  '.woff2',
  '.xls',
  '.xlsx',
  '.zip',
])
