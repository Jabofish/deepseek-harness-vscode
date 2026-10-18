import { useId, useRef, type ReactElement, type ReactNode, type RefObject } from 'react'
import { PopoverCard } from '../../components/common/PopoverCard.js'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
import { useViewportMenuPosition } from '../../components/common/useViewportMenuPosition.js'
import { Icon } from '../../ui/Icon.js'

export interface ComposerExtrasMenuProps {
  readonly open: boolean
  readonly disabled: boolean
  readonly count?: number
  readonly label: string
  readonly anchorRef: RefObject<HTMLElement | null>
  readonly onOpenChange: (open: boolean) => void
  readonly children: ReactNode
}

/**
 * Secondary command, open-file and configuration actions. Direct attachment
 * and current-editor shortcuts live in the input's floating toolbar.
 */
export function ComposerExtrasMenu(props: ComposerExtrasMenuProps): ReactElement {
  const dialogId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuPosition = useViewportMenuPosition({
    open: props.open,
    anchorRef: props.anchorRef,
    menuRef,
    placement: 'above',
    align: 'start',
  })

  useDismissibleLayer({
    open: props.open,
    refs: [rootRef, menuRef],
    onDismiss: () => props.onOpenChange(false),
  })

  return (
    <div ref={rootRef} className="dsh-composer__extras">
      <button
        className={`dsh-icon-button dsh-composer__extras-trigger${props.open ? ' dsh-composer__extras-trigger--open' : ''}`}
        type="button"
        aria-label={props.label}
        title={props.label}
        aria-expanded={props.open}
        aria-haspopup="dialog"
        aria-controls={props.open ? dialogId : undefined}
        disabled={props.disabled}
        onClick={() => props.onOpenChange(!props.open)}
      >
        <Icon name="add" />
        {props.count === undefined || props.count < 1 ? null : (
          <span className="dsh-composer__extras-count" aria-hidden="true">
            {props.count}
          </span>
        )}
      </button>
      {props.open ? (
        <PopoverCard
          ref={menuRef}
          className="dsh-composer__extras-panel"
          id={dialogId}
          role="dialog"
          aria-label={props.label}
          style={menuPosition}
        >
          {props.children}
        </PopoverCard>
      ) : null}
    </div>
  )
}
