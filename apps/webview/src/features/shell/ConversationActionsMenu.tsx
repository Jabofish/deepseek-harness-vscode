import { memo, useCallback, useRef, useState, type ReactElement, type ReactNode } from 'react'

import { PopoverCard } from '../../components/common/PopoverCard.js'
import { useViewportMenuPosition } from '../../components/common/useViewportMenuPosition.js'
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
export const ConversationActionsMenu = memo(function ConversationActionsMenu(
  props: ConversationActionsMenuProps,
): ReactElement {
  const { t } = useI18n()
  const { children, onClose } = props
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // The panel anchors to the trigger instead of the viewport top so a wrapped
  // narrow-sidebar topbar cannot detach it from the control that opened it.
  const panelRef = useRef<HTMLDivElement>(null)
  const panelPosition = useViewportMenuPosition({
    open,
    anchorRef: triggerRef,
    menuRef: panelRef,
    placement: 'below',
    align: 'end',
  })

  const close = useCallback((): void => {
    setOpen(false)
    onClose?.()
  }, [onClose])

  // Escape is owned by the layer hook alone: a React handler on this element
  // would run before the document listeners of the drawers nested inside the
  // panel and collapse both layers with one key press.
  useDismissibleLayer({
    open,
    refs: [rootRef],
    onDismiss: close,
    onEscape: () => {
      close()
      triggerRef.current?.focus()
    },
  })

  return (
    <div ref={rootRef} className="dsh-conversation__actions">
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
          ref={panelRef}
          className="dsh-conversation__actions-panel"
          style={panelPosition}
          role="dialog"
          aria-label={t('app.conversationActions')}
        >
          <div className="dsh-conversation__actions-grid">{children}</div>
        </PopoverCard>
      ) : null}
    </div>
  )
})
