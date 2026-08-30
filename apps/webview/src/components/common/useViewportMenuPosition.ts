import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

export interface ViewportMenuPositionOptions {
  readonly open: boolean
  readonly anchorRef: RefObject<HTMLElement | null>
  readonly menuRef: RefObject<HTMLElement | null>
  readonly placement?: 'above' | 'below'
  readonly align?: 'start' | 'end'
  readonly refreshKey?: unknown
  /**
   * Dynamic menu content may change height after opening. Most popovers need
   * to remeasure, but a menu that contains an inline picker must keep its
   * anchor stable while that picker expands.
   */
  readonly observeMenuResize?: boolean
  readonly gap?: number
  readonly margin?: number
}

/**
 * Positions a menu against its trigger without letting the menu escape the
 * Webview viewport. The menu remains in the feature's React tree, so outside
 * pointer handling and ownership stay local while the geometry is shared.
 */
export function useViewportMenuPosition({
  open,
  anchorRef,
  menuRef,
  placement = 'above',
  align = 'end',
  refreshKey,
  observeMenuResize = true,
  gap = 8,
  margin = 8,
}: ViewportMenuPositionOptions): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties | undefined>()

  useLayoutEffect(() => {
    if (!open) {
      setStyle(undefined)
      return
    }

    const update = (): void => {
      const anchor = anchorRef.current
      const menu = menuRef.current
      if (anchor === null || menu === null) return

      const viewportWidth = document.documentElement.clientWidth || window.innerWidth
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight
      const anchorRect = anchor.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      const availableWidth = Math.max(0, viewportWidth - margin * 2)
      const availableHeight = Math.max(0, viewportHeight - margin * 2)
      const width = Math.min(Math.max(menuRect.width, 1), availableWidth)
      const height = Math.min(Math.max(menuRect.height, 1), availableHeight)
      const direction = getComputedStyle(anchor).direction
      const alignedLeft =
        align === 'start'
          ? direction === 'rtl'
            ? anchorRect.right - width
            : anchorRect.left
          : direction === 'rtl'
            ? anchorRect.left
            : anchorRect.right - width
      const left = clamp(alignedLeft, margin, viewportWidth - width - margin)
      const aboveTop = anchorRect.top - gap - height
      const belowTop = anchorRect.bottom + gap
      const top =
        placement === 'below'
          ? belowTop + height <= viewportHeight - margin
            ? belowTop
            : Math.max(margin, aboveTop)
          : aboveTop >= margin
            ? aboveTop
            : belowTop + height <= viewportHeight - margin
              ? belowTop
              : Math.max(margin, Math.min(aboveTop, viewportHeight - height - margin))

      const nextStyle: CSSProperties = {
        position: 'fixed',
        top: `${Math.max(margin, top)}px`,
        right: 'auto',
        bottom: 'auto',
        left: `${left}px`,
        width: `${width}px`,
        maxWidth: 'none',
        visibility: 'visible',
      }

      setStyle((current) => (sameStyle(current, nextStyle) ? current : nextStyle))
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)

    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(update)
      if (anchorRef.current !== null) resizeObserver.observe(anchorRef.current)
      if (observeMenuResize && menuRef.current !== null) resizeObserver.observe(menuRef.current)
    }

    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      resizeObserver?.disconnect()
    }
  }, [align, anchorRef, gap, margin, menuRef, observeMenuResize, open, placement, refreshKey])

  return open ? (style ?? { position: 'fixed', visibility: 'hidden' }) : undefined
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum < minimum) return minimum
  return Math.min(maximum, Math.max(minimum, value))
}

function sameStyle(current: CSSProperties | undefined, next: CSSProperties): boolean {
  return (
    current?.top === next.top &&
    current?.left === next.left &&
    current?.width === next.width &&
    current?.visibility === next.visibility
  )
}
