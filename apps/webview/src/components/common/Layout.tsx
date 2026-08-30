import { createElement, forwardRef, type HTMLAttributes, type ReactElement, type ReactNode } from 'react'

type SurfaceElement = 'article' | 'div' | 'section'
type LayoutAttributes = Omit<HTMLAttributes<HTMLElement>, 'children'>

export interface SurfaceProps extends LayoutAttributes {
  readonly as?: SurfaceElement
  readonly children: ReactNode
}

/** The neutral surface primitive. Feature surfaces own their visual skin. */
export const Surface = forwardRef<HTMLElement, SurfaceProps>(function Surface(
  { as = 'div', children, className, ...props },
  ref,
): ReactElement {
  return createElement(
    as,
    {
      ...props,
      ref,
      className: `dsh-layout-surface${className === undefined ? '' : ` ${className}`}`,
      'data-layout': 'surface',
    },
    children,
  )
})

export interface StackProps extends LayoutAttributes {
  readonly children: ReactNode
  readonly gap?: 'none' | 'xs' | 'sm' | 'md' | 'lg'
}

/** A one-axis vertical layout with a deliberate, named spacing scale. */
export function Stack({ children, className, gap = 'md', ...props }: StackProps): ReactElement {
  return (
    <div
      {...props}
      className={`dsh-layout-stack dsh-layout-stack--${gap}${className === undefined ? '' : ` ${className}`}`}
      data-layout="stack"
    >
      {children}
    </div>
  )
}

export interface InlineProps extends LayoutAttributes {
  readonly children: ReactNode
  readonly gap?: 'none' | 'xs' | 'sm' | 'md' | 'lg'
  readonly wrap?: boolean
}

/** A one-line layout primitive; wrapping is opt-in instead of accidental. */
export function Inline({
  children,
  className,
  gap = 'sm',
  wrap = false,
  ...props
}: InlineProps): ReactElement {
  return (
    <div
      {...props}
      className={`dsh-layout-inline dsh-layout-inline--${gap}${wrap ? ' dsh-layout-inline--wrap' : ''}${className === undefined ? '' : ` ${className}`}`}
      data-layout="inline"
    >
      {children}
    </div>
  )
}
