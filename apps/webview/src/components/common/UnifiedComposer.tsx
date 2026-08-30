import { forwardRef, type FormHTMLAttributes, type ReactNode } from 'react'

export interface UnifiedComposerProps extends Omit<FormHTMLAttributes<HTMLFormElement>, 'children'> {
  readonly children: ReactNode
}

/**
 * The single visual boundary for prompt entry. Feature code owns the prompt
 * behavior; this component owns the stable form/card contract shared by the
 * composer and future prompt surfaces.
 */
export const UnifiedComposer = forwardRef<HTMLFormElement, UnifiedComposerProps>(function UnifiedComposer(
  { children, className, ...props },
  ref,
): React.ReactElement {
  return (
    <form
      {...props}
      ref={ref}
      className={`dsh-unified-composer${className === undefined ? '' : ` ${className}`}`}
      data-component="unified-composer"
    >
      {children}
    </form>
  )
})
