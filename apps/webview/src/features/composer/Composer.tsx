import type { ReactElement } from 'react'
import type { PromptAttachment } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface ComposerProps {
  readonly disabled: boolean
  readonly running: boolean
  readonly draft: string
  readonly attachments: readonly PromptAttachment[]
  readonly onDraftChange: (value: string) => void
  readonly onSubmit: () => void
  readonly onCancel: () => void
}

export function Composer(props: ComposerProps): ReactElement {
  return unimplemented<ReactElement>('prompt composer', [
    'support multiline text, IME composition, Shift+Enter newline, and configurable submit behavior',
    'display removable workspace/file attachments selected through Extension Host APIs',
    'switch Send to Stop only for a running active turn',
    'prevent duplicate submissions while preserving a recoverable draft',
    'show active model, tools mode, permissions, and plan mode as compact controls',
    `disabled ${String(props.disabled)}; running ${String(props.running)}; draft length ${props.draft.length}; attachments ${props.attachments.length}; callbacks ${typeof props.onDraftChange}/${typeof props.onSubmit}/${typeof props.onCancel}`,
  ])
}
