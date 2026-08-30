import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react'

import { PopoverCard } from '../../components/common/PopoverCard.js'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface ConversationActionsMenuProps {
  readonly children: ReactNode
  readonly onClose?: () => void
}

/**
 * Holds low-frequency conversation tools behind one stable chrome control.
 *
 * The menu is deliberately owned by the shell rather than by each feature:
 * the topbar stays one line at every width, while feature drawers retain
 * their own focus and outside-click behavior inside this surface.
 */
export function ConversationActionsMenu(props: ConversationActionsMenuProps): ReactElement {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const close = useCallback((): void => {
    setOpen(false)
    props.onClose?.()
  }, [props.onClose])

  useDismissibleLayer({
    open,
    refs: [rootRef],
    onDismiss: close,
    onEscape: () => {
      close()
      triggerRef.current?.focus()
    },
  })

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    close()
    triggerRef.current?.focus()
  }

  return (
    <div ref={rootRef} className="dsh-conversation__actions" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        className="dsh-icon-button dsh-conversation__actions-trigger"
        type="button"
        aria-label={t('app.conversationActions')}
        title={t('app.conversationActions')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) close()
          else setOpen(true)
        }}
      >
        <Icon name="more" />
      </button>
      {open ? (
        <PopoverCard
          className="dsh-conversation__actions-panel"
          role="dialog"
          aria-label={t('app.conversationActions')}
        >
          <div className="dsh-conversation__actions-grid">{props.children}</div>
        </PopoverCard>
      ) : null}
    </div>
  )
}
