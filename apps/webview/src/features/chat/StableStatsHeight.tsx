import { useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react'

/** Keep a session's statistics from repeatedly changing the composer's height. */
export function StableStatsHeight({ children }: { readonly children: ReactNode }): ReactElement {
  const outerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const outer = outerRef.current
    const content = contentRef.current
    if (outer === null || content === null || typeof ResizeObserver === 'undefined') return

    let previousWidth = 0
    let reservedHeight = 0
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      const height = content.offsetHeight
      if (width <= 0 || height <= 0) return
      // Recompute at a different width, but do not collapse when changing
      // numbers or transient billing status make the same-width line shorter.
      reservedHeight = Math.abs(width - previousWidth) > 0.5 ? height : Math.max(reservedHeight, height)
      previousWidth = width
      outer.style.minHeight = `${reservedHeight}px`
    })
    observer.observe(content, { box: 'border-box' })
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={outerRef}>
      <div ref={contentRef}>{children}</div>
    </div>
  )
}
