import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * The attachment rail's horizontal paging: whether the row actually overflows
 * (and therefore needs the page buttons), re-checked on scroll, resize, and
 * whenever the attachment list changes length.
 */
export function useAttachmentRail(attachmentCount: number): {
  readonly railRef: RefObject<HTMLUListElement | null>
  readonly scrollable: boolean
} {
  const railRef = useRef<HTMLUListElement>(null)
  const [scrollable, setScrollable] = useState(false)
  useEffect(() => {
    const element = railRef.current
    if (element === null) return
    const update = (): void => setScrollable(element.scrollWidth > element.clientWidth + 1)
    update()
    element.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(element)
    return () => {
      element.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [attachmentCount])
  return { railRef, scrollable }
}
