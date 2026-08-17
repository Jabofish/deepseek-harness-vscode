import { useState, type ReactElement } from 'react'
import type { SessionExportOptions } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'

export interface ExportDialogProps {
  readonly sessionId: string
  readonly onExport: (options: SessionExportOptions) => void
}

export function ExportDialog(props: ExportDialogProps): ReactElement {
  const { t } = useI18n()
  const [format, setFormat] = useState<SessionExportOptions['format']>('markdown')
  const [includeAttachments, setIncludeAttachments] = useState(true)
  const [includeReasoning, setIncludeReasoning] = useState(true)
  // rc.6's ZIP archive is produced wholly by the host's session-log download;
  // it always carries attachments and reasoning, so neither toggle can opt out.
  const zipLocked = format === 'zip'
  return (
    <form
      className="dsh-export"
      onSubmit={(event) => {
        event.preventDefault()
        props.onExport({
          sessionId: props.sessionId,
          format,
          includeAttachments: zipLocked || includeAttachments,
          includeReasoning: zipLocked || includeReasoning,
        })
      }}
    >
      <h2>{t('export.title')}</h2>
      <p>{t('export.sensitive')}</p>
      <label>
        {t('export.format')}{' '}
        <select
          value={format}
          onChange={(event) => setFormat(event.target.value as SessionExportOptions['format'])}
        >
          <option value="markdown">Markdown</option>
          <option value="json">JSON</option>
          <option value="zip">ZIP</option>
        </select>
      </label>
      {zipLocked ? <p className="dsh-export__zip-hint">{t('export.zipHint')}</p> : null}
      <label>
        <input
          type="checkbox"
          checked={zipLocked || includeAttachments}
          disabled={zipLocked}
          onChange={(event) => setIncludeAttachments(event.target.checked)}
        />{' '}
        {t('export.attachments')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={zipLocked || includeReasoning}
          disabled={zipLocked}
          onChange={(event) => setIncludeReasoning(event.target.checked)}
        />{' '}
        {t('export.reasoning')}
      </label>
      <button className="dsh-button dsh-button--primary" type="submit">
        {t('export.submit')}
      </button>
    </form>
  )
}
