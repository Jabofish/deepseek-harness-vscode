import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react'
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
  /** Keep the opener across a loading dialog's replacement by its real content. */
  readonly returnFocusRef?: RefObject<HTMLElement | null>
  readonly onCaptureReturnFocus?: (element: HTMLElement | null) => void
}): ReactElement {
  const { t } = useI18n()
  const titleId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const previousRef = useRef<HTMLElement | null>(null)
  const { returnFocusRef, onCaptureReturnFocus } = props
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    previousRef.current = returnFocusRef?.current ?? previous
    onCaptureReturnFocus?.(previous)
    closeRef.current?.focus()
  }, [returnFocusRef, onCaptureReturnFocus])
  useDismissibleLayer({ open: true, refs: [dialogRef], trapFocus: true, onDismiss: props.onClose })
  useEffect(() => {
    const previous = previousRef.current
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
