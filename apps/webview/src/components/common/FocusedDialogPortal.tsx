import { cloneElement, useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useConversationLayout } from '../../app/ConversationLayoutProvider.js'
import './focused-dialog-portal.css'

/** Keep editing and confirmation surfaces independent from their scrollable list. */
export function FocusedDialogPortal(props: {
  readonly children: ReactElement<{ readonly children?: ReactNode }>
  readonly error?: string | undefined
}): ReactElement {
  const layerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (props.error !== undefined)
      layerRef.current?.querySelector('[role="alert"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [props.error])
  const content = cloneElement(
    props.children,
    {},
    <>
      {props.error === undefined ? null : (
        <div className="dsh-feature-dialog-error" role="alert">
          {props.error}
        </div>
      )}
      {props.children.props.children}
    </>,
  )
  if (useConversationLayout()?.layout !== 'focused') return content
  return createPortal(
    <div ref={layerRef} className="dsh-focused-dialog-layer">
      {content}
    </div>,
    document.body,
  )
}
