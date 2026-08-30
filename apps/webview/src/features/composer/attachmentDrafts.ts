import type { PromptAttachment } from '@dsh-vscode/domain'

/**
 * Extra identity available for an attachment before the Extension Host has
 * returned its opaque handle. It stays in the Webview only for draft-level
 * de-duplication and is never sent as authority to DSH.
 */
export type AttachmentDraftOrigin =
  | {
      readonly kind: 'browser-file'
      readonly sizeBytes: number
      readonly lastModified: number
      readonly relativePath: string
    }
  | {
      readonly kind: 'open-file'
      readonly id: string
    }

/** Build a stable, presentation-safe identity for one draft attachment. */
export function attachmentDraftKey(
  attachment: Pick<PromptAttachment, 'name' | 'mimeType'>,
  origin?: AttachmentDraftOrigin,
): string {
  const originKey =
    origin === undefined
      ? 'opaque'
      : origin.kind === 'open-file'
        ? `open:${stableText(origin.id)}`
        : `file:${origin.sizeBytes}:${origin.lastModified}:${stableText(origin.relativePath)}`
  return [originKey, stableText(attachment.name), stableText(attachment.mimeType)].join('\u0000')
}

export function browserFileOrigin(file: File): AttachmentDraftOrigin {
  return {
    kind: 'browser-file',
    sizeBytes: file.size,
    lastModified: file.lastModified,
    relativePath: file.webkitRelativePath,
  }
}

function stableText(value: string | undefined): string {
  return (value ?? '').trim().normalize('NFC').toLowerCase()
}
