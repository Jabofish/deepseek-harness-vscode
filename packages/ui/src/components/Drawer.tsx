import { useEffect, useRef, type PropsWithChildren, type ReactElement } from 'react'

export interface DrawerProps extends PropsWithChildren {
  readonly title: string
  readonly open: boolean
  readonly side?: 'left' | 'right'
  readonly onClose: () => void
}

export function Drawer(props: DrawerProps): ReactElement | null {
  const { open, onClose } = props
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || dialogRef.current === null) return
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute('disabled'))
      if (focusable.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previousFocus.current?.focus()
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="dsh-drawer__backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <section
        ref={dialogRef}
        className={`dsh-drawer dsh-drawer--${props.side ?? 'right'}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsh-drawer-title"
        tabIndex={-1}
      >
        <header className="dsh-drawer__header">
          <h2 id="dsh-drawer-title">{props.title}</h2>
          <button type="button" aria-label="Close" onClick={props.onClose}>
            ×
          </button>
        </header>
        <div className="dsh-drawer__body">{props.children}</div>
      </section>
    </div>
  )
}
