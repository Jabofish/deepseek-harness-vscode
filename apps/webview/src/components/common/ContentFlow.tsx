import { createElement, forwardRef, type HTMLAttributes, type ReactElement, type ReactNode } from 'react'

type ContentFlowElement = 'code' | 'dd' | 'details' | 'div' | 'li' | 'ol' | 'p' | 'small' | 'span' | 'strong'

export type ContentFlowVariant = 'prose' | 'preserve-breaks' | 'code' | 'truncate'

export interface ContentFlowProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  readonly as?: ContentFlowElement
  readonly children?: ReactNode
  readonly variant?: ContentFlowVariant
}

/**
 * Shared text-flow primitive for user-visible, variable-length content.
 *
 * The primitive deliberately does not add visual decoration. It only gives
 * prose a predictable width and wrapping contract, while code/path surfaces
 * can opt into their own explicit preservation mode through a modifier.
 */
export const ContentFlow = forwardRef<HTMLElement, ContentFlowProps>(function ContentFlow(
  { as = 'div', children, className, variant = 'prose', ...props },
  ref,
): ReactElement {
  const variantClass = variant === 'prose' ? '' : ` dsh-content-flow--${variant}`
  return createElement(
    as,
    {
      ...props,
      ref,
      className: `dsh-content-flow${variantClass}${className === undefined ? '' : ` ${className}`}`,
      'data-component': 'content-flow',
    },
    children,
  )
})
