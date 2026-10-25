import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

import { PopoverCard } from '../../components/common/PopoverCard.js'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
import { useViewportMenuPosition } from '../../components/common/useViewportMenuPosition.js'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface SessionRowActionsProps {
  readonly title: string
  /** The row's own mutation or any list-wide mutation is in flight. */
  readonly disabled: boolean
  /** Absent when the surface cannot host an editor tab (no such menu entry). */
  readonly onOpenInEditor?: (() => void) | undefined
  readonly onRename: (trigger: HTMLElement) => void
  /** Absent for a blank session, which has nothing to archive yet. */
  readonly onArchive?: (() => void) | undefined
}

/**
 * The one row control that owns the row's rarer actions.
 *
 * The row used to reveal an action rail on hover and let it take its width out
 * of the title column. Revealing it therefore re-wrapped the title and resized
 * the row, so moving across the list re-laid-out every row it touched. A
 * single trigger participates in the row grid in every state and the actions
 * live in a menu, which keeps the title column — and the row's height — fixed.
 */
export function SessionRowActions(props: SessionRowActionsProps): ReactElement {
  const { t } = useI18n()
  const { onOpenInEditor, onRename, onArchive, disabled } = props
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const firstItemRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const label = t('sessions.actions', { title: props.title })
  // The panel card is a size-query container, so a fixed menu inside it would
  // be positioned against the card rather than the viewport. The menu is
  // portalled and anchored to the trigger instead.
  const position = useViewportMenuPosition({
    open,
    anchorRef: triggerRef,
    menuRef: panelRef,
    placement: 'below',
    align: 'end',
  })

  const close = useCallback((): void => {
    setOpen(false)
  }, [])

  useDismissibleLayer({
    open,
    refs: [rootRef, panelRef],
    onDismiss: close,
    onEscape: () => {
      close()
      triggerRef.current?.focus()
    },
  })

  // A mutation that starts while the menu is open must not leave its entries
  // actionable behind a trigger that just became disabled. This is the render
  // form of "derive state from props": adjusting during render closes the menu
  // in the same commit that locks the row, without an effect round-trip.
  const [rowWasLocked, setRowWasLocked] = useState(disabled)
  if (rowWasLocked !== disabled) {
    setRowWasLocked(disabled)
    if (disabled) setOpen(false)
  }

  // The menu is reachable from the keyboard, so its first action takes focus
  // instead of leaving focus on the trigger behind the opened surface. The
  // positioning pass hides the surface until it has been measured, and Chromium
  // cannot focus a hidden element, so focus waits for that first visible pass.
  const measuredVisible = position?.visibility !== 'hidden'
  useEffect(() => {
    if (open && measuredVisible) firstItemRef.current?.focus()
  }, [measuredVisible, open])

  const run = (action: () => void): void => {
    close()
    action()
  }

  return (
    <div ref={rootRef} className="dsh-session-item__actions">
      <button
        ref={triggerRef}
        className="dsh-icon-button"
        type="button"
        aria-label={label}
        title={t('sessions.actionsTitle')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="more" />
      </button>
      {open
        ? createPortal(
            <PopoverCard
              ref={panelRef}
              id={menuId}
              className="dsh-session-item__menu-panel"
              style={position}
              role="dialog"
              aria-label={label}
            >
              <div className="dsh-session-item__menu-list">
                {onOpenInEditor === undefined ? null : (
                  <button ref={firstItemRef} type="button" onClick={() => run(onOpenInEditor)}>
                    {t('sessions.openInEditorTitle')}
                  </button>
                )}
                <button
                  ref={onOpenInEditor === undefined ? firstItemRef : undefined}
                  type="button"
                  onClick={() => {
                    // The rename dialog returns focus to the control that
                    // opened it, which is this trigger once the menu closes.
                    const trigger = triggerRef.current
                    if (trigger === null) return
                    run(() => onRename(trigger))
                  }}
                >
                  {t('sessions.renameTitle')}
                </button>
                {onArchive === undefined ? null : (
                  <button type="button" onClick={() => run(onArchive)}>
                    {t('sessions.archiveTitle')}
                  </button>
                )}
              </div>
            </PopoverCard>,
            document.body,
          )
        : null}
    </div>
  )
}
