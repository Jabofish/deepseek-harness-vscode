import type { PromptAttachment } from '@dsh-vscode/domain'

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
