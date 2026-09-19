import { useEffect, useRef, type ReactElement } from 'react'
import { Icon } from '../../ui/Icon.js'
import { useI18n } from '../../i18n.js'

export interface AttachmentLightboxProps {
  readonly name: string
  readonly src: string | undefined
  /** The preview request already settled without an image, so the placeholder
   * is a terminal failure rather than a pending load. */
  readonly unavailable?: boolean
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
      // A layer that is already open consumes Escape first; a surface that acts
      // regardless would collapse both with one key press. `preventDefault` is
      // how the layer hook marks the key as consumed.
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      props.onClose()
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
            className="dsh-icon-button"
            type="button"
            aria-label={t('composer.closePreview')}
            title={t('composer.closePreview')}
            onClick={props.onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        {props.src !== undefined ? (
          <img className="dsh-lightbox__image" src={props.src} alt={props.name} />
        ) : props.unavailable === true ? (
          <div className="dsh-lightbox__placeholder" role="alert">
            {t('timeline.imageUnavailable')}
          </div>
        ) : (
          <div className="dsh-lightbox__placeholder" role="status">
            {t('composer.loadingPreview')}
          </div>
        )}
      </div>
    </div>
  )
}
