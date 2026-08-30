import { useEffect, useRef, type RefObject } from 'react'

export interface DismissibleLayerOptions {
  readonly open: boolean
  /** Every DOM surface that belongs to this layer, including portal content. */
  readonly refs: readonly RefObject<HTMLElement | null>[]
  readonly onDismiss: () => void
  readonly onEscape?: () => void
}

/**
 * Owns the document-level dismissal contract for menus and lightweight
 * dialogs. Related surfaces are explicit refs instead of an assumption about
 * the DOM tree, so a portal or a nested popup remains clickable.
 */
export function useDismissibleLayer({
  open,
  refs,
  onDismiss,
  onEscape,
}: DismissibleLayerOptions): void {
  const refsRef = useRef(refs)
  const dismissRef = useRef(onDismiss)
  const escapeRef = useRef(onEscape)
  refsRef.current = refs
  dismissRef.current = onDismiss
  escapeRef.current = onEscape

  useEffect(() => {
    if (!open) return

    const isInside = (event: Event): boolean => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : []
      const target = event.target
      return refsRef.current.some((ref) => {
        const element = ref.current
        if (element === null) return false
        if (path.includes(element)) return true
        return target instanceof Node && element.contains(target)
      })
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (!isInside(event)) dismissRef.current()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      const escapeHandler = escapeRef.current ?? dismissRef.current
      escapeHandler()
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])
}
