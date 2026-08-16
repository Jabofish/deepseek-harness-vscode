import type { ReactElement } from 'react'
import type { PromptAttachment } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface AttachmentPickerProps {
  readonly attachments: readonly PromptAttachment[]
  readonly onPick: () => void
  readonly onRemove: (uri: string) => void
}

export function AttachmentPicker(props: AttachmentPickerProps): ReactElement {
  return unimplemented<ReactElement>('image and file attachment picker', [
    'support paste, drag-and-drop, and Extension Host file selection',
    'accept only DSH-supported image/file types and enforce per-file plus total size limits',
    'render safe local previews through controlled Webview URIs',
    'retain history metadata while releasing object URLs and large buffers promptly',
    'never read a dropped directory recursively',
    `attachments ${props.attachments.length}; callbacks ${typeof props.onPick}/${typeof props.onRemove}`,
  ])
}
