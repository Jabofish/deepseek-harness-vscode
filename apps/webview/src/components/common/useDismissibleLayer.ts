import { useLayoutEffect, useRef, type RefObject } from 'react'

export interface DismissibleLayerOptions {
  readonly open: boolean
  /** Every DOM surface that belongs to this layer, including portal content. */
  readonly refs: readonly RefObject<HTMLElement | null>[]
  readonly onDismiss: () => void
  readonly onEscape?: () => void
  /** Give the active layer first chance to handle Tab before its modal trap. */
  readonly onTab?: (event: KeyboardEvent) => void
  /** Keep sequential keyboard focus inside this layer while it is open. */
  readonly trapFocus?: boolean
}

/**
 * Open layers in the order they were opened. Every layer listens on the same
 * document target, so registration order would otherwise decide the winner;
 * a layer opened on top of another always registers later, which lets the
 * stack name the innermost surface deterministically.
 */
type LayerRefsRef = { current: readonly RefObject<HTMLElement | null>[] }

interface LayerRegistration {
  readonly identity: object
  readonly refsRef: LayerRefsRef
  parentFocusTrap: FocusTrapRegistration | undefined
}

interface FocusTrapRegistration extends LayerRegistration {
  readonly children: Set<LayerRegistration>
}

const openLayers: LayerRegistration[] = []
const openFocusTraps: FocusTrapRegistration[] = []
const changedBackgroundInert = new Map<HTMLElement, boolean>()

const TAB_STOP_SELECTOR =
  'a[href], area[href], audio[controls], button, details > summary:first-of-type, iframe, input:not([type="hidden"]), object, select, textarea, video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]'

function isHiddenFromSequentialFocus(element: HTMLElement): boolean {
  let current: HTMLElement | null = element
  while (current !== null) {
    if (
      current.hidden ||
      current.hasAttribute('inert') ||
      current.getAttribute('aria-hidden') === 'true' ||
      current.matches(':disabled')
    )
      return true
    const style = window.getComputedStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')
      return true
    current = current.parentElement
  }
  return false
}

function focusableElements(refs: readonly RefObject<HTMLElement | null>[]): HTMLElement[] {
  const found = new Set<HTMLElement>()
  for (const ref of refs) {
    const root = ref.current
    if (root === null) continue
    for (const element of root.querySelectorAll<HTMLElement>(TAB_STOP_SELECTOR)) {
      if (
        !element.isConnected ||
        element.tabIndex < 0 ||
        (element instanceof HTMLInputElement && element.type === 'hidden') ||
        isHiddenFromSequentialFocus(element)
      )
        continue
      found.add(element)
    }
  }
  return [...found].sort((left, right) => {
    const leftTabIndex = left.tabIndex
    const rightTabIndex = right.tabIndex
    if (leftTabIndex > 0 || rightTabIndex > 0) {
      if (leftTabIndex <= 0) return 1
      if (rightTabIndex <= 0) return -1
      if (leftTabIndex !== rightTabIndex) return leftTabIndex - rightTabIndex
    }
    const position = left.compareDocumentPosition(right)
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1
    return 0
  })
}

function restoreBackgroundInertness(): void {
  for (const [element, wasInert] of changedBackgroundInert) element.toggleAttribute('inert', wasInert)
  changedBackgroundInert.clear()
}

function inertOutsideFocusRoots(parent: HTMLElement, roots: readonly HTMLElement[]): void {
  for (const child of Array.from(parent.children)) {
    if (!(child instanceof HTMLElement)) continue
    const allowedRoots = roots.filter((root) => root === child || child.contains(root))
    if (allowedRoots.length === 0) {
      if (!child.hasAttribute('inert')) {
        changedBackgroundInert.set(child, false)
        child.setAttribute('inert', '')
      }
      continue
    }
    if (!allowedRoots.includes(child)) inertOutsideFocusRoots(child, allowedRoots)
  }
}

function updateBackgroundInertness(): void {
  restoreBackgroundInertness()
  const topFocusTrap = openFocusTraps.at(-1)
  if (topFocusTrap === undefined) return
  const refs = [
    ...topFocusTrap.refsRef.current,
    ...[...topFocusTrap.children].flatMap((child) => child.refsRef.current),
  ]
  const roots = refs.flatMap((ref) => (ref.current?.isConnected === true ? [ref.current] : []))
  if (roots.length > 0) inertOutsideFocusRoots(document.body, roots)
}

function keepTabFocusInLayer(event: KeyboardEvent, refs: readonly RefObject<HTMLElement | null>[]): void {
  const roots = refs.flatMap((ref) => (ref.current === null ? [] : [ref.current]))
  const tabbable = focusableElements(refs)
  if (tabbable.length === 0) {
    const root = roots.find((element) => element.isConnected)
    if (root === undefined) return
    event.preventDefault()
    root.focus()
    return
  }

  const active = document.activeElement
  const activeIndex = tabbable.findIndex((element) => element === active)
  const direction = event.shiftKey ? -1 : 1
  const nextIndex =
    activeIndex === -1
      ? event.shiftKey
        ? tabbable.length - 1
        : 0
      : (activeIndex + direction + tabbable.length) % tabbable.length
  event.preventDefault()
  tabbable[nextIndex]?.focus()
}

function focusIsWithinLayer(refs: readonly RefObject<HTMLElement | null>[]): boolean {
  const active = document.activeElement
  return refs.some((ref) => ref.current !== null && (ref.current === active || ref.current.contains(active)))
}

/**
 * Owns document-level dismissal and keyboard behavior for layers. A non-modal
 * layer opened above a focus trap belongs to that trap's focus scope; its
 * document listener owns Tab so it can handle its own behavior before the
 * modal applies the scope boundary. Related surfaces are explicit refs, so
 * portal content participates even when it is outside the modal's DOM tree.
 */
export function useDismissibleLayer({
  open,
  refs,
  onDismiss,
  onEscape,
  onTab,
  trapFocus = false,
}: DismissibleLayerOptions): void {
  const refsRef = useRef(refs)
  const dismissRef = useRef(onDismiss)
  const escapeRef = useRef(onEscape)
  const tabRef = useRef(onTab)

  useLayoutEffect(() => {
    refsRef.current = refs
    dismissRef.current = onDismiss
    escapeRef.current = onEscape
    tabRef.current = onTab
    updateBackgroundInertness()
  }, [onDismiss, onEscape, onTab, refs])

  useLayoutEffect(() => {
    if (!open) return
    const identity = {}
    const topFocusTrap = openFocusTraps.at(-1)
    const focusTrap: FocusTrapRegistration | undefined = trapFocus
      ? { identity, refsRef, parentFocusTrap: undefined, children: new Set() }
      : undefined
    const layer: LayerRegistration = focusTrap ?? { identity, refsRef, parentFocusTrap: topFocusTrap }
    if (layer.parentFocusTrap !== undefined) layer.parentFocusTrap.children.add(layer)
    openLayers.push(layer)
    if (focusTrap !== undefined) openFocusTraps.push(focusTrap)
    updateBackgroundInertness()

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
      if (event.key === 'Tab') {
        const activeLayer = openLayers.at(-1)
        if (activeLayer?.identity !== identity) return
        const activeFocusTrap = openFocusTraps.at(-1)
        const focusScope =
          activeFocusTrap !== undefined &&
          (activeFocusTrap.identity === identity || layer.parentFocusTrap === activeFocusTrap)
            ? [
                ...activeFocusTrap.refsRef.current,
                ...[...activeFocusTrap.children].flatMap((child) => child.refsRef.current),
              ]
            : undefined
        if (!event.defaultPrevented) tabRef.current?.(event)
        if (focusScope === undefined) return
        if (event.defaultPrevented) {
          if (!focusIsWithinLayer(focusScope)) keepTabFocusInLayer(event, focusScope)
          return
        }
        keepTabFocusInLayer(event, focusScope)
        return
      }
      if (event.defaultPrevented) return
      if (event.key !== 'Escape') return
      // A layer that is not the innermost open surface must leave the key for
      // the popover stacked on top of it.
      if (openLayers.at(-1)?.identity !== identity) return
      event.preventDefault()
      const escapeHandler = escapeRef.current ?? dismissRef.current
      escapeHandler()
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      const index = openLayers.lastIndexOf(layer)
      if (index !== -1) openLayers.splice(index, 1)
      layer.parentFocusTrap?.children.delete(layer)
      if (focusTrap !== undefined) {
        for (const child of focusTrap.children) child.parentFocusTrap = undefined
        focusTrap.children.clear()
      }
      const focusTrapIndex = focusTrap === undefined ? -1 : openFocusTraps.lastIndexOf(focusTrap)
      if (focusTrapIndex !== -1) openFocusTraps.splice(focusTrapIndex, 1)
      updateBackgroundInertness()
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, trapFocus])
}
