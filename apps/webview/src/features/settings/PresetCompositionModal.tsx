import type { Ref, ReactElement } from 'react'

import { useI18n } from '../../i18n.js'

export interface PresetView {
  readonly id: string
  readonly title: string
  readonly content: string
}

export function PresetCompositionModal({
  view,
  loading,
  error,
  overlayRef,
  onErrorDismiss,
  onClose,
}: {
  readonly view: PresetView | undefined
  readonly loading: boolean
  readonly error: string | undefined
  readonly overlayRef: Ref<HTMLDivElement>
  readonly onErrorDismiss: () => void
  readonly onClose: () => void
}): ReactElement | null {
  const { t } = useI18n()
  return loading || error !== undefined ? (
    <div className="dsh-presets__modal-backdrop" role="presentation">
      <div
        ref={overlayRef}
        className="dsh-presets__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('presets.composition')}
      >
        <h3>{error === undefined ? t('presets.compositionLoading') : t('presets.composition')}</h3>
        {error === undefined ? (
          <p className="dsh-settings__empty" role="status">
            {t('presets.loading')}
          </p>
        ) : (
          <p className="dsh-presets__dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="dsh-presets__dialog-actions">
          <button
            className="dsh-button dsh-button--secondary dsh-button--compact"
            type="button"
            disabled={loading}
            onClick={onErrorDismiss}
          >
            {t('presets.close')}
          </button>
        </div>
      </div>
    </div>
  ) : view === undefined ? null : (
    <div className="dsh-presets__modal-backdrop" role="presentation">
      <div
        ref={overlayRef}
        className="dsh-presets__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('presets.composition')}
      >
        <h3>{t('presets.compositionHeading', { name: view.title })}</h3>
        <pre className="dsh-presets__code">{view.content}</pre>
        <div className="dsh-presets__dialog-actions">
          <button
            className="dsh-button dsh-button--secondary dsh-button--compact"
            type="button"
            autoFocus
            onClick={onClose}
          >
            {t('presets.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
