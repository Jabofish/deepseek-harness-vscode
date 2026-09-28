import { useId, useLayoutEffect, useRef, type ReactElement } from 'react'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
import { Icon } from '../../ui/Icon.js'
import type { Translate } from '../../i18n.js'

/** Host/OS refusal while opening a file or URL from a tool card. The retry
 * repeats the sanctioned Host open operation; it never replays a tool call. */
export function ToolLinkErrorDialog({
  href,
  message,
  busy,
  onClose,
  onRetry,
  t,
}: {
  readonly href: string
  readonly message: string
  readonly busy: boolean
  readonly onClose: () => void
  readonly onRetry: () => void
  readonly t: Translate
}): ReactElement {
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  useLayoutEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])
  // The dialog is `aria-modal`: Tab cycles inside it, the rest of the page
  // goes inert, and Escape and outside presses dismiss it through the shared
  // layer so outer owners never collapse alongside it.
  useDismissibleLayer({
    open: true,
    refs: [dialogRef],
    onDismiss: () => onCloseRef.current(),
    trapFocus: true,
  })

  useLayoutEffect(() => {
    // The modal owns the keyboard while it is up, but only takes it back when
    // the keyboard is not already inside: re-running this on every render
    // would drag focus off whichever control the user had reached while the
    // timeline kept streaming. A mount that starts busy (a retry still in
    // flight) takes focus as soon as its controls are enabled.
    const dialog = dialogRef.current
    const active = document.activeElement
    if (dialog !== null && active !== null && dialog.contains(active)) return
    closeRef.current?.focus()
  }, [busy])

  return (
    <div
      className="dsh-tool-error-modal__backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        ref={dialogRef}
        className="dsh-tool-error-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="dsh-tool-error-modal__header">
          <h2 id={titleId}>{t('timeline.openErrorTitle')}</h2>
          <button
            ref={closeRef}
            className="dsh-icon-button"
            type="button"
            aria-label={t('app.dismissError')}
            title={t('app.dismissError')}
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        <p id={descriptionId} className="dsh-tool-error-modal__message">
          {message}
        </p>
        <code className="dsh-tool-error-modal__path" title={href}>
          {href}
        </code>
        <footer className="dsh-tool-error-modal__actions">
          <button
            className="dsh-button dsh-button--secondary"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            {t('timeline.cancelOpen')}
          </button>
          <button className="dsh-button dsh-button--primary" type="button" onClick={onRetry} disabled={busy}>
            {t('timeline.retryOpen')}
          </button>
        </footer>
      </section>
    </div>
  )
}
