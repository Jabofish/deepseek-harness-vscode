import { useCallback, useEffect, useReducer, useRef, type PropsWithChildren, type ReactElement } from 'react'

export interface DrawerProps extends PropsWithChildren {
  readonly title: string
  readonly open: boolean
  readonly side?: 'left' | 'right'
  readonly onClose: () => void
}

// The fallback is intentionally a little longer than the slow entrance token:
// it is an unload safety net, not an animation duration. It protects the DOM
// when a browser does not dispatch animationend for an interrupted exit.
const CLOSE_FALLBACK_MS = 360

type DrawerPhase = 'closed' | 'open' | 'closing'

type DrawerAction = { readonly type: 'sync'; readonly open: boolean } | { readonly type: 'finish' }

export function Drawer(props: DrawerProps): ReactElement | null {
  const { open, onClose } = props
  const [phase, dispatch] = useReducer(drawerReducer, open ? 'open' : 'closed')
  // The prop determines visibility immediately. The phase only keeps an
  // already-mounted surface alive for its exit animation.
  const mounted = open || phase !== 'closed'
  const closing = !open && phase !== 'closed'
  const dialogRef = useRef<HTMLElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const fallbackTimerRef = useRef<number | undefined>(undefined)

  const finishClose = useCallback((): void => {
    if (fallbackTimerRef.current !== undefined) {
      window.clearTimeout(fallbackTimerRef.current)
      fallbackTimerRef.current = undefined
    }
    dispatch({ type: 'finish' })
  }, [])

  useEffect(() => {
    dispatch({ type: 'sync', open })
  }, [open])

  useEffect(() => {
    if (!closing) return
    fallbackTimerRef.current = window.setTimeout(finishClose, CLOSE_FALLBACK_MS)
    return () => {
      if (fallbackTimerRef.current !== undefined) window.clearTimeout(fallbackTimerRef.current)
      fallbackTimerRef.current = undefined
    }
  }, [closing, finishClose])

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

  if (!mounted) return null
  return (
    <div
      className="dsh-drawer__backdrop"
      data-state={closing ? 'closing' : 'open'}
      role="presentation"
      onMouseDown={(event) => {
        if (closing) return
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <section
        ref={dialogRef}
        className={`dsh-drawer dsh-drawer--${props.side ?? 'right'}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsh-drawer-title"
        aria-hidden={closing || undefined}
        tabIndex={-1}
        onAnimationEnd={(event) => {
          if (closing && event.target === dialogRef.current) finishClose()
        }}
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

function drawerReducer(phase: DrawerPhase, action: DrawerAction): DrawerPhase {
  if (action.type === 'finish') return phase === 'closing' ? 'closed' : phase
  if (action.open) return 'open'
  return phase === 'closed' ? 'closed' : 'closing'
}
