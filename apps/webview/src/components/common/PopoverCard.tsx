import { forwardRef, type HTMLAttributes, type ReactElement, type ReactNode } from 'react'
import { Surface } from './Layout.js'

export interface PopoverCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  readonly children: ReactNode
}

/** Standard anchored surface for menus, switchers, and lightweight dialogs. */
export const PopoverCard = forwardRef<HTMLDivElement, PopoverCardProps>(function PopoverCard(
  { children, className, ...props },
  ref,
): ReactElement {
  return (
    <Surface
      {...props}
      ref={ref}
      className={`dsh-popover-card${className === undefined ? '' : ` ${className}`}`}
      data-component="popover-card"
    >
      {children}
    </Surface>
  )
})

export interface ModalWrapperProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  readonly children: ReactNode
}

/** Standard full-screen modal layer; the child surface supplies its own size. */
export function ModalWrapper({ children, className, ...props }: ModalWrapperProps): ReactElement {
  return (
    <Surface
      {...props}
      className={`dsh-modal-wrapper${className === undefined ? '' : ` ${className}`}`}
      data-component="modal-wrapper"
    >
      {children}
    </Surface>
  )
}
