import { useState, type ReactElement } from 'react'
import type { SessionExportOptions } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { SelectMenu } from '../../components/common/SelectMenu.js'

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
      <div className="dsh-export__format">
        <span>{t('export.format')}</span>
        <SelectMenu
          icon="file"
          density="regular"
          displayLabel
          label={t(`export.format.${format}`)}
          ariaLabel={t('export.format')}
          title={t('export.format')}
          value={format}
          options={[
            { value: 'markdown', label: t('export.format.markdown') },
            { value: 'json', label: t('export.format.json') },
            { value: 'zip', label: t('export.format.zip') },
          ]}
          placement="below"
          onChange={(value) => {
            if (value === 'markdown' || value === 'json' || value === 'zip') setFormat(value)
          }}
        />
      </div>
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
