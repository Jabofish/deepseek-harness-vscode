import { AppError, type PromptAttachment } from '@dsh-vscode/domain'

export interface ParsedBase64DataUri {
  readonly mediaType: string
  readonly encoded: string
}

/** Parse a data URI without decoding or accepting a non-base64 payload. */
export function parseBase64DataUri(value: string): ParsedBase64DataUri | undefined {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/iu.exec(value)
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined
  return { mediaType: match[1].toLowerCase(), encoded: match[2] }
}

/** Validate canonical RFC 4648 Base64 before passing data to Buffer. */
export function isCanonicalBase64(value: string): boolean {
  return value.length % 4 === 0 && (value === '' || /^[A-Za-z0-9+/]+={0,2}$/u.test(value))
}

export function decodeCanonicalBase64(
  value: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): Buffer | undefined {
  if (!isCanonicalBase64(value)) return undefined
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > maximumBytes || bytes.toString('base64') !== value) return undefined
  return bytes
}

export type Base64PayloadProblem = 'invalid' | 'too-large' | 'not-canonical'

/**
 * Decode a Base64 payload while keeping the failure reason. `decodeCanonicalBase64`
 * only answers "no", so callers cannot tell a malformed encoding from a payload
 * that is merely larger than the caller will carry.
 */
export function decodeBase64Payload(
  value: string,
  maximumBytes: number,
): { readonly bytes: Buffer } | { readonly problem: Base64PayloadProblem } {
  if (!isCanonicalBase64(value)) return { problem: 'invalid' }
  // Size is decided before decoding so an oversized payload is never allocated
  // and a non-canonical length can never be blamed on its size.
  if (decodedByteLength(value) > maximumBytes) return { problem: 'too-large' }
  const bytes = decodeCanonicalBase64(value, maximumBytes)
  return bytes === undefined ? { problem: 'not-canonical' } : { bytes }
}

export function isSupportedImageMimeType(mediaType: string): boolean {
  return SUPPORTED_IMAGE_TYPES.has(mediaType.toLowerCase())
}

export function matchesImageSignature(mediaType: string, bytes: Buffer): boolean {
  if (mediaType === 'image/png')
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mediaType === 'image/jpeg')
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mediaType === 'image/gif') {
    const header = bytes.subarray(0, 6).toString('ascii')
    return header === 'GIF87a' || header === 'GIF89a'
  }
  if (mediaType === 'image/webp')
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    )
  return false
}

export function encodeImageAttachments(
  attachments: readonly PromptAttachment[],
): readonly Record<string, string>[] | undefined {
  const images: Record<string, string>[] = []
  for (const attachment of attachments) {
    const parsed = parseBase64DataUri(attachment.uri)
    if (parsed === undefined || !isSupportedImageMimeType(parsed.mediaType)) return undefined
    images.push({
      mediaType: parsed.mediaType,
      data: parsed.encoded,
      ...(attachment.name === '' ? {} : { name: attachment.name }),
    })
  }
  return images
}

export interface PromptContentLimits {
  readonly maxImageBytes: number
  readonly maxAttachmentTotalBytes: number
  readonly maxImageTotalBytes: number
  readonly maxImagesPerMessage?: number
  readonly mediaTypes?: ReadonlySet<string>
}

/** Encode the upload-shaped content shared by Session and subagent prompts. */
export function encodePromptContent(
  text: string,
  attachments: readonly PromptAttachment[],
  limits: PromptContentLimits,
): readonly Record<string, string>[] {
  let totalBytes = 0
  let imageBytes = 0
  let imageCount = 0
  const content: Record<string, string>[] = [{ type: 'text', text }]
  for (const attachment of attachments) {
    const parsed = parseBase64DataUri(attachment.uri)
    if (parsed === undefined)
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The attachment must be a supported base64 data URI.',
        retryable: false,
      })
    const mediaType = parsed.mediaType
    const encoded = parsed.encoded
    const image = isSupportedImageMimeType(mediaType)
    if (image && limits.mediaTypes !== undefined && !limits.mediaTypes.has(mediaType))
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The attachment image type is not accepted by DSH.',
        retryable: false,
      })
    const maximumBytes = image ? limits.maxImageBytes : MAX_TEXT_ATTACHMENT_BYTES
    const decoded = decodeBase64Payload(encoded, maximumBytes)
    if ('problem' in decoded)
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message:
          decoded.problem === 'too-large'
            ? 'The attachment is too large.'
            : decoded.problem === 'invalid'
              ? 'The attachment encoding is invalid.'
              : 'The attachment encoding is not canonical Base64.',
        retryable: false,
      })
    const bytes = decoded.bytes
    if (image && limits.maxImagesPerMessage !== undefined) {
      imageCount += 1
      if (imageCount > limits.maxImagesPerMessage)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The message contains too many images for DSH.',
          retryable: false,
        })
    }
    totalBytes += bytes.length
    if (totalBytes > limits.maxAttachmentTotalBytes)
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The combined attachment size is too large.',
        retryable: false,
      })
    if (image) {
      imageBytes += bytes.length
      if (imageBytes > limits.maxImageTotalBytes)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The combined image size is too large for DSH.',
          retryable: false,
        })
      if (bytes.length === 0 || !matchesImageSignature(mediaType, bytes))
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The attachment contents do not match a supported image.',
          retryable: false,
        })
      content.push({ type: 'image', mediaType, data: encoded, name: safeAttachmentName(attachment.name) })
      continue
    }
    if (!isTextAttachment(mediaType, attachment.name, bytes))
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'This DSH integration supports images and text-based files only.',
        retryable: false,
      })
    const name = safeAttachmentName(attachment.name)
    const attachmentText = bytes.toString('utf8')
    content.push({
      type: 'text',
      text: `\n\nAttached file: ${name}\n\n${attachmentText}\n\nEnd of attached file: ${name}`,
    })
  }
  return content
}

/**
 * Recognize the envelope `encodePromptContent` writes around an inlined text
 * file. The wrapper is deliberately marked so no consumer has to guess where
 * the file starts or ends: the durable message, the queue row, and a redacted
 * export all read the same shape back.
 */
const ATTACHED_FILE_BLOCK =
  /^\s*Attached file: ([^\r\n]+)\r?\n\r?\n[\s\S]*\r?\n\r?\nEnd of attached file: \1\s*$/u

export interface AttachedFileEnvelope {
  readonly name: string
}

/** Returns the file's display name for an inlined text-file envelope. */
export function attachedFileEnvelope(value: string): AttachedFileEnvelope | undefined {
  const match = ATTACHED_FILE_BLOCK.exec(value)
  const name = match?.[1]?.trim()
  return name === undefined || name === '' ? undefined : { name }
}

export function isTextAttachment(mediaType: string, name: string, bytes: Buffer): boolean {
  if (!validTextBytes(bytes)) return false
  if (mediaType.startsWith('text/') || TEXT_ATTACHMENT_MIME_TYPES.has(mediaType)) return true
  const extension = extensionFromName(name)
  return !BINARY_ATTACHMENT_EXTENSIONS.has(extension) && TEXT_ATTACHMENT_EXTENSIONS.has(extension)
}

export function safeAttachmentName(name: string): string {
  const baseName = name.split(/[\\/]/u).pop() ?? name
  const sanitized = Array.from(baseName, (character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f ? ' ' : character
  })
    .join('')
    .trim()
  return (sanitized === '' ? 'file' : sanitized).slice(0, 256)
}

/** Decoded size of canonical Base64 without allocating the payload. */
function decodedByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function validTextBytes(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false
  return !bytes.toString('utf8').includes('\ufffd')
}

function extensionFromName(name: string): string {
  const baseName = name.split(/[\\/]/u).pop() ?? name
  const dot = baseName.lastIndexOf('.')
  return dot <= 0 ? '' : baseName.slice(dot).toLowerCase()
}

const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_TEXT_ATTACHMENT_BYTES = 8 * 1024 * 1024

const TEXT_ATTACHMENT_MIME_TYPES = new Set([
  'application/json',
  'application/javascript',
  'application/sql',
  'application/toml',
  'application/typescript',
  'application/x-sh',
  'application/x-yaml',
  'application/xml',
  'application/yaml',
])

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.hpp',
  '.htm',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.log',
  '.md',
  '.mjs',
  '.py',
  '.rs',
  '.scss',
  '.sh',
  '.sql',
  '.svelte',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh',
])

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
  '.mov',
  '.mp3',
  '.mp4',
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
