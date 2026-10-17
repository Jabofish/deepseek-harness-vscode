import { useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { ModalWrapper } from './PopoverCard.js'
import { useDismissibleLayer } from './useDismissibleLayer.js'

/** A modal owns its focus and stacking independently from the surface that opened it. */
export function ModalDialog(props: {
  readonly title: string
  readonly closeLabel?: string
  readonly onClose: () => void
  readonly children: ReactNode
}): ReactElement {
  const { t } = useI18n()
  const titleId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useDismissibleLayer({ open: true, refs: [dialogRef], trapFocus: true, onDismiss: props.onClose })
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return createPortal(
    <ModalWrapper>
      <section
        ref={dialogRef}
        className="dsh-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="dsh-modal-dialog__header">
          <h2 id={titleId}>{props.title}</h2>
          <button
            ref={closeRef}
            className="dsh-icon-button"
            type="button"
            aria-label={props.closeLabel ?? t('common.close')}
            onClick={props.onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        {props.children}
      </section>
    </ModalWrapper>,
    document.body,
  )
}
