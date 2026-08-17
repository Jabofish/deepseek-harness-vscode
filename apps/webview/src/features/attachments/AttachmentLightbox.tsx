import { useEffect, useRef, type ReactElement } from 'react'
import { Icon } from '../../ui/Icon.js'
import { useI18n } from '../../i18n.js'

export interface AttachmentLightboxProps {
  readonly name: string
  readonly src: string | undefined
  readonly onClose: () => void
}

export function AttachmentLightbox(props: AttachmentLightboxProps): ReactElement {
  const { t } = useI18n()
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
  }, [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        props.onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [props])
  return (
    <div
      className="dsh-lightbox__backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div
        className="dsh-lightbox"
        role="dialog"
        aria-modal="true"
        aria-label={t('composer.preview', { name: props.name })}
      >
        <div className="dsh-lightbox__header">
          <span className="dsh-lightbox__name" title={props.name}>
            {props.name}
          </span>
          <button
            ref={closeRef}
            className="dsh-icon-button dsh-lightbox__close"
            type="button"
            aria-label={t('composer.closePreview')}
            title={t('composer.closePreview')}
            onClick={props.onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        {props.src === undefined ? (
          <div className="dsh-lightbox__placeholder" role="status">
            {t('composer.loadingPreview')}
          </div>
        ) : (
          <img className="dsh-lightbox__image" src={props.src} alt={props.name} />
        )}
      </div>
    </div>
  )
}
