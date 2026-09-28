import type { Ref, ReactElement } from 'react'

import { useI18n } from '../../i18n.js'

export function PresetDeleteDialog({
  presetId,
  deleting,
  overlayRef,
  onCancel,
  onConfirm,
}: {
  readonly presetId: string
  readonly deleting: boolean
  readonly overlayRef: Ref<HTMLDivElement>
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): ReactElement {
  const { t } = useI18n()
  return (
    <div className="dsh-presets__modal-backdrop" role="presentation">
      <div
        ref={overlayRef}
        className="dsh-presets__dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={t('presets.deleteAria')}
      >
        <h3>{t('presets.deleteHeading')}</h3>
        <p>{t('presets.deletePrompt', { name: presetId })}</p>
        <div className="dsh-presets__dialog-actions">
          <button
            className="dsh-button dsh-button--secondary dsh-button--compact"
            type="button"
            disabled={deleting}
            autoFocus
            onClick={onCancel}
          >
            {t('presets.cancel')}
          </button>
          <button
            className="dsh-button dsh-button--danger dsh-button--compact"
            type="button"
            disabled={deleting}
            onClick={onConfirm}
          >
            {deleting ? t('presets.deleting') : t('presets.deleteAction')}
          </button>
        </div>
      </div>
    </div>
  )
}
