import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import './focused-dialog-portal.css'

function withErrorSlot(children: ReactNode, errorSlot: ReactElement): ReactNode {
  const items = Children.toArray(children)
  const actionsIndex = items.findLastIndex(
    (item) =>
      isValidElement<{ readonly className?: string }>(item) &&
      typeof item.props.className === 'string' &&
      item.props.className.split(/\s+/).some((token) => token.endsWith('__dialog-actions')),
  )
  if (actionsIndex === -1) return [...items, errorSlot]
  return [...items.slice(0, actionsIndex), errorSlot, ...items.slice(actionsIndex)]
}

/** Keep editing and confirmation surfaces independent from their scrollable list in either layout. */
export function FocusedDialogPortal(props: {
  readonly children: ReactElement<{ readonly children?: ReactNode }>
  readonly error?: string | undefined
}): ReactElement {
  const layerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (props.error !== undefined)
      layerRef.current?.querySelector('[role="alert"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [props.error])
  // Reserve one line for async action failures so appearing alerts never vertically shift the modal.
  const errorSlot = (
    <div
      key="__dsh-feature-dialog-error"
      className="dsh-feature-dialog-error"
      role={props.error === undefined ? undefined : 'alert'}
      aria-hidden={props.error === undefined ? true : undefined}
    >
      <span>{props.error ?? ''}</span>
    </div>
  )
  const content = cloneElement(props.children, {}, withErrorSlot(props.children.props.children, errorSlot))
  return createPortal(
    <div ref={layerRef} className="dsh-focused-dialog-layer">
      {content}
    </div>,
    document.body,
  )
}
