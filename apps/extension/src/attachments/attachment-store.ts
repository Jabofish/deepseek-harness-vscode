import { randomUUID } from 'node:crypto'
import { AppError, type PromptAttachment } from '@dsh-vscode/domain'

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

export interface StoredAttachmentInput {
  readonly dataUri: string
  readonly name: string
  readonly mimeType?: string
}

interface StoredAttachment extends StoredAttachmentInput {
  readonly expiresAt: number
}

export interface AttachmentHandle {
  readonly uri: string
  readonly name: string
  readonly mimeType?: string | undefined
}

/** Decode only canonical RFC 4648 Base64. Node's permissive decoder is not a
 * validation boundary: it silently accepts missing padding and stray forms. */
export function decodeCanonicalBase64(value: string, maximumBytes = MAX_ATTACHMENT_BYTES): Buffer {
  if (value === '' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw invalidBase64()
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > maximumBytes || bytes.toString('base64') !== value) throw invalidBase64()
  return bytes
}

export class AttachmentStore {
  private readonly values = new Map<string, StoredAttachment>()

  public constructor(
    private readonly now: () => number = Date.now,
    private readonly makeToken: () => string = () => randomUUID(),
  ) {}

  public remember(input: StoredAttachmentInput): AttachmentHandle {
    this.prune()
    if (this.values.size >= 8) throw attachmentCapacityReached()
    const token = `dsh-attachment:${this.makeToken()}`
    this.values.set(token, { ...input, expiresAt: this.now() + 10 * 60 * 1000 })
    return {
      uri: token,
      name: input.name,
      ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
    }
  }

  public resolve(attachments: readonly AttachmentHandle[]): readonly PromptAttachment[] {
    this.prune()
    return attachments.map((attachment) => {
      const stored = this.values.get(attachment.uri)
      if (stored === undefined) throw unavailableAttachment()
      return {
        uri: stored.dataUri,
        name: stored.name,
        ...(stored.mimeType === undefined ? {} : { mimeType: stored.mimeType }),
      }
    })
  }

  public preview(uri: string): string | undefined {
    this.prune()
    const stored = this.values.get(uri)
    return stored !== undefined && isImageMimeType(stored.mimeType ?? '') ? stored.dataUri : undefined
  }

  public release(attachments: readonly AttachmentHandle[]): void {
    for (const attachment of attachments) this.values.delete(attachment.uri)
  }

  public releaseUris(uris: readonly string[]): void {
    for (const uri of uris) this.values.delete(uri)
  }

  public clear(): void {
    this.values.clear()
  }

  public get size(): number {
    this.prune()
    return this.values.size
  }

  private prune(): void {
    const now = this.now()
    for (const [token, attachment] of this.values) if (attachment.expiresAt <= now) this.values.delete(token)
  }
}

export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/')
}

export function validImageBytes(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === 'image/png')
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mimeType === 'image/jpeg')
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mimeType === 'image/gif') {
    const header = bytes.subarray(0, 6).toString('ascii')
    return header === 'GIF87a' || header === 'GIF89a'
  }
  if (mimeType === 'image/webp')
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    )
  return false
}

function invalidBase64(): AppError {
  return new AppError({
    code: 'INVALID_CONFIGURATION',
    message: 'The pasted or dropped file could not be decoded.',
    retryable: false,
  })
}

function unavailableAttachment(): AppError {
  return new AppError({
    code: 'INVALID_CONFIGURATION',
    message: 'The attachment is no longer available. Select it again.',
    retryable: false,
  })
}

function attachmentCapacityReached(): AppError {
  return new AppError({
    code: 'INVALID_CONFIGURATION',
    message: 'At most 8 attachment drafts may be kept. Remove one and try again.',
    retryable: false,
  })
}
