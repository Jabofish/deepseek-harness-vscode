import { useState, type ReactElement } from 'react'
import type { SessionExportOptions } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { SelectMenu } from '../../components/common/SelectMenu.js'
import { ModalDialog } from '../../components/common/ModalDialog.js'

const STORAGE_KEY = 'dsh-export-format'
const VALID_FORMATS: readonly SessionExportOptions['format'][] = ['markdown', 'json', 'zip']

function storedFormat(): SessionExportOptions['format'] | undefined {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return VALID_FORMATS.find((entry) => entry === value)
  } catch {
    return undefined
  }
}

function saveFormat(value: SessionExportOptions['format']): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value)
  } catch {
    /* Restricted storage keeps the dialog usable. */
  }
}

export interface ExportDialogProps {
  readonly sessionId: string
  /** Resolves once the Host finished (or the user cancelled) the export. */
  readonly onExport: (options: SessionExportOptions) => Promise<void> | void
  readonly onClose: () => void
  /** False when the connected runtime cannot produce a ZIP archive. */
  readonly zipAvailable?: boolean
}

export function ExportDialog(props: ExportDialogProps): ReactElement {
  const { t } = useI18n()
  const zipAvailable = props.zipAvailable !== false
  const [format, setFormat] = useState<SessionExportOptions['format']>(() => {
    const stored = storedFormat() ?? 'markdown'
    return stored === 'zip' && !zipAvailable ? 'markdown' : stored
  })
  const [includeAttachments, setIncludeAttachments] = useState(true)
  const [includeReasoning, setIncludeReasoning] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  // rc.6's ZIP archive is produced wholly by the host's session-log download;
  // it always carries attachments and reasoning, so neither toggle can opt out.
  const zipLocked = format === 'zip'
  return (
    <ModalDialog title={t('export.title')} onClose={submitting ? () => undefined : props.onClose}>
      <form
        className="dsh-export"
        onSubmit={(event) => {
          event.preventDefault()
          if (submitting) return
          saveFormat(format)
          const result = props.onExport({
            sessionId: props.sessionId,
            format,
            includeAttachments: zipLocked || includeAttachments,
            includeReasoning: zipLocked || includeReasoning,
          })
          if (result !== undefined && typeof (result as PromiseLike<void>).then === 'function') {
            setSubmitting(true)
            void Promise.resolve(result).finally(() => setSubmitting(false))
          }
        }}
      >
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
              ...(zipAvailable ? [{ value: 'zip' as const, label: t('export.format.zip') }] : []),
            ]}
            placement="below"
            onChange={(value) => {
              if (value === 'markdown' || value === 'json' || (value === 'zip' && zipAvailable))
                setFormat(value)
            }}
          />
        </div>
        {zipLocked ? <p className="dsh-export__zip-hint">{t('export.zipHint')}</p> : null}
        {zipAvailable ? null : <p className="dsh-export__zip-hint">{t('export.zipUnavailable')}</p>}
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
        <footer className="dsh-export__actions">
          <button
            className="dsh-button dsh-button--secondary"
            type="button"
            disabled={submitting}
            onClick={props.onClose}
          >
            {t('common.cancel')}
          </button>
          <button className="dsh-button dsh-button--primary" type="submit" disabled={submitting}>
            {t(submitting ? 'export.submitting' : 'export.submit')}
          </button>
        </footer>
      </form>
    </ModalDialog>
  )
}
