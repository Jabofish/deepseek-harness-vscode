import { useState, type ReactElement } from 'react'
import type { SessionExportOptions } from '@dsh-vscode/domain'

export interface ExportDialogProps {
  readonly sessionId: string
  readonly onExport: (options: SessionExportOptions) => void
}

export function ExportDialog(props: ExportDialogProps): ReactElement {
  const [format, setFormat] = useState<SessionExportOptions['format']>('markdown')
  const [includeAttachments, setIncludeAttachments] = useState(true)
  const [includeReasoning, setIncludeReasoning] = useState(true)
  return (
    <form
      className="dsh-export"
      onSubmit={(event) => {
        event.preventDefault()
        props.onExport({ sessionId: props.sessionId, format, includeAttachments, includeReasoning })
      }}
    >
      <h2>Export session</h2>
      <p>Exports may contain prompts, tool output, and other sensitive content.</p>
      <label>
        Format{' '}
        <select
          value={format}
          onChange={(event) => setFormat(event.target.value as SessionExportOptions['format'])}
        >
          <option value="markdown">Markdown</option>
          <option value="json">JSON</option>
          <option value="zip">ZIP</option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={includeAttachments}
          onChange={(event) => setIncludeAttachments(event.target.checked)}
        />{' '}
        Include attachments
      </label>
      <label>
        <input
          type="checkbox"
          checked={includeReasoning}
          onChange={(event) => setIncludeReasoning(event.target.checked)}
        />{' '}
        Include reasoning
      </label>
      <button type="submit">Choose destination and export</button>
    </form>
  )
}
