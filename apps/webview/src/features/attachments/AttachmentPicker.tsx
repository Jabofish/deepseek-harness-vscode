import type { ReactElement } from 'react'
import type { PromptAttachment } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'

export interface AttachmentPickerProps {
  readonly attachments: readonly PromptAttachment[]
  readonly onPick: () => void
  readonly onRemove: (uri: string) => void
}

export function AttachmentPicker(props: AttachmentPickerProps): ReactElement {
  return (
    <div className="dsh-attachments" aria-label="Attachments">
      <button className="dsh-button dsh-button--secondary" type="button" onClick={props.onPick}>
        <Icon name="paperclip" />
        Attach file
      </button>
      {props.attachments.map((attachment) => (
        <span className="dsh-attachment" key={attachment.uri}>
          <Icon name={attachment.mimeType?.startsWith('image/') === true ? 'image' : 'file'} />
          <span title={attachment.name}>{attachment.name}</span>
          <button
            className="dsh-icon-button"
            type="button"
            aria-label={`Remove ${attachment.name}`}
            onClick={() => props.onRemove(attachment.uri)}
          >
            <Icon name="close" />
          </button>
        </span>
      ))}
    </div>
  )
}
