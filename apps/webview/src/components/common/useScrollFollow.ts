import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { getAccessibilitySignals, subscribeAccessibilitySignals } from '../../app/accessibility-signals.js'

const DEFAULT_BOTTOM_THRESHOLD = 64
const USER_SCROLL_IDLE_MS = 220
const SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '])

interface ScheduledFollow {
  readonly cancel: () => void
}

/** Native controls and inner scrollports own their input before the transcript does. */
function controlOwnsKey(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('input, textarea, select, button, summary, [role="button"]') !== null) return true
  const editable = target.closest('[contenteditable]')
  return editable !== null && editable.getAttribute('contenteditable') !== 'false'
}

function nestedScrollConsumes(owner: HTMLElement, target: EventTarget | null, direction: number): boolean {
  for (
    let node = target instanceof Element ? target : null;
    node !== null && node !== owner;
    node = node.parentElement
  ) {
    if (!(node instanceof HTMLElement) || node.scrollHeight <= node.clientHeight) continue
    const style = window.getComputedStyle(node)
    if (!/^(auto|scroll|overlay)$/u.test(style.overflowY)) continue
    if (
      direction === 0 ||
      (direction < 0 ? node.scrollTop > 0 : node.scrollTop < node.scrollHeight - node.clientHeight) ||
      style.overscrollBehaviorY === 'contain' ||
      style.overscrollBehaviorY === 'none'
    )
      return true
  }
  return false
}

export interface ScrollFollowOptions {
  /** A stable identity for the append-only stream being displayed. */
  readonly contentKey: string | number
  /** The number of records currently available in the scroll owner. */
  readonly itemCount: number
  /** Reset the reader to the tail when the displayed session changes. */
  readonly sessionId?: string | undefined
  /** Distance from the tail at which the reader is still considered pinned. */
  readonly bottomThreshold?: number
  /**
   * Observe consumer content size changes for late layout growth. Long
   * virtualized collections opt out because their measurement pass changes
   * the estimated canvas height while the reader is moving.
   */
  readonly observeContentSize?: boolean
  /** A virtual canvas may clamp a pinned offset while its estimates settle. */
  readonly layoutMeasurementsActive?: boolean
  /** Reconcile consumer layout that was deferred while the reader was moving. */
  readonly onScrollIdle?: () => void
}

/** A reader position captured before an older history page is inserted. */
export interface ScrollAnchor {
  readonly contentHeight: number
  readonly scrollTop: number
  readonly interactionGeneration: number
  /** Internal measured-height adjustments already applied when captured. */
  readonly measurementAdjustment?: number
  readonly nodeId?: string
  readonly nodeOffset?: number
}

export interface ScrollFollowResult {
  readonly scrollRef: RefObject<HTMLDivElement | null>
  readonly contentRef: RefObject<HTMLDivElement | null>
  readonly handleScroll: () => void
  readonly scrollToLatest: () => void
  /** Move to the tail from an explicit reader action with smooth motion. */
  readonly userScrollToLatest: () => void
  /** A deliberate reader navigation, such as revealing a selected Inspector row. */
  readonly userScrollToOffset: (offset: number) => void
  /** Capture the current position for a guarded prepend restoration. */
  readonly captureScrollAnchor: () => ScrollAnchor | undefined
  /** Whether a captured anchor still belongs to the current reader interaction. */
  readonly isScrollAnchorCurrent: (anchor: ScrollAnchor) => boolean
  /** Restore a captured prepend position only while the reader is still there. */
  readonly restoreScrollAnchor: (anchor: ScrollAnchor) => boolean
  /** Apply a virtualizer's measured-height delta without changing reader mode. */
  readonly applyScrollAdjustment: (delta: number) => void
  /** Whether the latest scroll was caused by an active reader gesture. */
  readonly isUserScrollActive: () => boolean
  /** Reconcile after a consumer-owned layout measurement changes its height. */
  readonly scheduleScrollToLatest: (options?: ScrollFollowScheduleOptions) => void
  /** Whether the browser is currently following the append-only tail. */
  readonly isPinnedToBottom: boolean
  readonly showJumpToLatest: boolean
}

export interface ScrollFollowScheduleOptions {
  /**
   * Preserve an already pinned reader while a consumer changes layout. The
   * next native scroll event can be caused by browser clamping rather than a
   * physical reader gesture, so keep the tail intent until reconciliation.
   */
  readonly preserveBottom?: boolean
  /** Correct a known layout transition before the browser paints it. */
  readonly immediate?: boolean
}

/**
 * Owns the scroll contract shared by append-only conversation surfaces.
 *
 * There is deliberately one scroll-position writer. Ordinary resize and
 * content updates coalesce within the current turn; known layout transitions
 * are corrected synchronously before paint. Captured wheel, pointer and keyboard
 * gestures cancel a pending follow before native scrolling takes effect.
 */
export function useScrollFollow(options: ScrollFollowOptions): ScrollFollowResult {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const previousSessionRef = useRef(options.sessionId)
  const scheduledFrameRef = useRef<ScheduledFollow | undefined>(undefined)
  const userScrollIdleTimerRef = useRef<number | undefined>(undefined)
  const userScrollActiveRef = useRef(false)
  const interactionGenerationRef = useRef(0)
  const measurementAdjustmentRef = useRef(0)
  const internalScrollTopRef = useRef<number | undefined>(undefined)
  const lastReaderScrollTopRef = useRef<number | undefined>(undefined)
  const viewportHeightRef = useRef(0)
  const preserveBottomOnLayoutRef = useRef(false)
  const layoutProtectionTimerRef = useRef<number | undefined>(undefined)
  const smoothScrollActiveRef = useRef(false)
  const scrollHandlerRef = useRef<() => void>(() => undefined)
  const itemCountRef = useRef(options.itemCount)
  const scrollIdleListenerRef = useRef(options.onScrollIdle)
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const bottomThreshold = options.bottomThreshold ?? DEFAULT_BOTTOM_THRESHOLD

  const cancelScheduledFollow = useCallback((): void => {
    const scheduled = scheduledFrameRef.current
    if (scheduled === undefined) return
    scheduled.cancel()
    scheduledFrameRef.current = undefined
  }, [])

  const clearUserScrollLock = useCallback((): void => {
    if (userScrollIdleTimerRef.current !== undefined) {
      window.clearTimeout(userScrollIdleTimerRef.current)
      userScrollIdleTimerRef.current = undefined
    }
    userScrollActiveRef.current = false
    smoothScrollActiveRef.current = false
  }, [])

  const clearLayoutProtection = useCallback((): void => {
    if (layoutProtectionTimerRef.current !== undefined) {
      window.clearTimeout(layoutProtectionTimerRef.current)
      layoutProtectionTimerRef.current = undefined
    }
    preserveBottomOnLayoutRef.current = false
  }, [])

  const armLayoutProtection = useCallback((): void => {
    if (layoutProtectionTimerRef.current !== undefined) window.clearTimeout(layoutProtectionTimerRef.current)
    layoutProtectionTimerRef.current = window.setTimeout(() => {
      layoutProtectionTimerRef.current = undefined
      preserveBottomOnLayoutRef.current = false
    }, USER_SCROLL_IDLE_MS)
  }, [])

  const restoreReaderPosition = useCallback((): boolean => {
    const element = scrollRef.current
    const savedScrollTop = lastReaderScrollTopRef.current
    if (
      element === null ||
      savedScrollTop === undefined ||
      stickToBottomRef.current ||
      userScrollActiveRef.current
    )
      return false

    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
    if (savedScrollTop > 1 && maxScrollTop <= 1) {
      internalScrollTopRef.current = element.scrollTop
      return false
    }
    const nextScrollTop = Math.min(maxScrollTop, Math.max(0, savedScrollTop))
    internalScrollTopRef.current = nextScrollTop
    if (Math.abs(element.scrollTop - nextScrollTop) > 0.5) {
      element.scrollTop = nextScrollTop
    }
    // Keep the intended position through a temporarily shorter canvas. A real
    // reader scroll replaces it in handleScroll; a layout clamp must not.
    return true
  }, [])

  const applyScrollAdjustment = useCallback((delta: number): void => {
    if (!Number.isFinite(delta) || Math.abs(delta) <= 0.5 || smoothScrollActiveRef.current) return
    const element = scrollRef.current
    if (element === null) return

    // If a virtualized canvas was briefly collapsed, the DOM can report zero
    // even though the reader was stably in the middle. Continue from the last
    // reader position so a measurement delta cannot turn that clamp into a
    // jump to the top. During an active gesture, the live DOM value wins.
    const savedScrollTop = lastReaderScrollTopRef.current
    const isCollapsedFreeReader =
      !stickToBottomRef.current &&
      !userScrollActiveRef.current &&
      element.scrollTop <= 1 &&
      savedScrollTop !== undefined &&
      savedScrollTop > 1
    const baseScrollTop = isCollapsedFreeReader ? (savedScrollTop ?? 0) : element.scrollTop
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
    if (isCollapsedFreeReader && maxScrollTop <= 1) {
      internalScrollTopRef.current = element.scrollTop
      return
    }
    const nextScrollTop = Math.min(maxScrollTop, Math.max(0, baseScrollTop + delta))
    const previousScrollTop = element.scrollTop
    internalScrollTopRef.current = nextScrollTop
    element.scrollTop = nextScrollTop
    measurementAdjustmentRef.current += element.scrollTop - previousScrollTop
    lastReaderScrollTopRef.current = nextScrollTop
  }, [])

  const scrollToLatest = useCallback((): void => {
    clearUserScrollLock()
    cancelScheduledFollow()
    const element = scrollRef.current
    if (element === null || element.clientHeight <= 0) return

    stickToBottomRef.current = true
    setIsPinnedToBottom(true)
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
    // Retain ownership even if layout already clamped to this offset. Chromium
    // can still deliver the pending scroll event after the resize callback.
    internalScrollTopRef.current = maxScrollTop
    if (Math.abs(element.scrollTop - maxScrollTop) > 0.5) {
      element.scrollTop = maxScrollTop
    }
    lastReaderScrollTopRef.current = maxScrollTop
    viewportHeightRef.current = element.clientHeight
    setShowJumpToLatest(false)
  }, [cancelScheduledFollow, clearUserScrollLock])

  const userScrollToLatest = useCallback((): void => {
    clearLayoutProtection()
    clearUserScrollLock()
    cancelScheduledFollow()
    const element = scrollRef.current
    if (element === null) return

    interactionGenerationRef.current += 1
    stickToBottomRef.current = true
    setIsPinnedToBottom(true)
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
    setShowJumpToLatest(false)

    const reduceMotion = getAccessibilitySignals().reducedMotion
    if (
      reduceMotion ||
      Math.abs(element.scrollTop - maxScrollTop) <= 0.5 ||
      typeof element.scrollTo !== 'function'
    ) {
      internalScrollTopRef.current = maxScrollTop
      element.scrollTop = maxScrollTop
      lastReaderScrollTopRef.current = maxScrollTop
      return
    }

    internalScrollTopRef.current = undefined
    smoothScrollActiveRef.current = true
    element.scrollTo({ top: maxScrollTop, behavior: 'smooth' })
  }, [cancelScheduledFollow, clearLayoutProtection, clearUserScrollLock])

  useLayoutEffect(
    () =>
      subscribeAccessibilitySignals(() => {
        if (getAccessibilitySignals().reducedMotion && smoothScrollActiveRef.current) scrollToLatest()
      }),
    [scrollToLatest],
  )

  const userScrollToOffset = useCallback(
    (offset: number): void => {
      if (!Number.isFinite(offset)) return
      clearLayoutProtection()
      clearUserScrollLock()
      cancelScheduledFollow()
      const element = scrollRef.current
      if (element === null) return
      interactionGenerationRef.current += 1
      stickToBottomRef.current = false
      setIsPinnedToBottom(false)
      setShowJumpToLatest(true)
      const next = Math.min(Math.max(0, element.scrollHeight - element.clientHeight), Math.max(0, offset))
      internalScrollTopRef.current = next
      lastReaderScrollTopRef.current = next
      element.scrollTop = next
    },
    [cancelScheduledFollow, clearLayoutProtection, clearUserScrollLock],
  )

  const scheduleScrollToLatest = useCallback(
    (scheduleOptions?: ScrollFollowScheduleOptions): void => {
      // Native smooth scrolling owns the offset until scrollend. Streaming or
      // resize reconciliation must not replace that motion with a sudden jump.
      if (smoothScrollActiveRef.current) return
      // A free reader may be clamped by a normal-flow/virtualized-canvas
      // transition. Restore the last observed reader position first; this
      // path never changes a free reader into tail-following mode.
      restoreReaderPosition()
      const preserveBottom =
        scheduleOptions?.preserveBottom === true &&
        stickToBottomRef.current &&
        !userScrollActiveRef.current &&
        itemCountRef.current > 0
      if (preserveBottom) preserveBottomOnLayoutRef.current = true
      if (preserveBottom && scheduleOptions?.immediate === true) {
        // A known layout transition runs from a layout effect or a
        // ResizeObserver callback. Correct synchronously so the browser never
        // paints its transient clamped offset before reconciliation can run.
        cancelScheduledFollow()
        scrollToLatest()
        armLayoutProtection()
        return
      }
      const shouldFollow = stickToBottomRef.current || preserveBottomOnLayoutRef.current
      if (userScrollActiveRef.current || !shouldFollow || itemCountRef.current === 0) return
      // Reconcile the latest committed layout once per turn, without a timer
      // or frame wait. A captured reader gesture can still cancel this write.
      if (scheduledFrameRef.current !== undefined) return
      const scheduledGeneration = interactionGenerationRef.current

      const run = (): void => {
        scheduledFrameRef.current = undefined
        const preserveBottom = preserveBottomOnLayoutRef.current
        if (
          scheduledGeneration === interactionGenerationRef.current &&
          !userScrollActiveRef.current &&
          (stickToBottomRef.current || preserveBottom)
        ) {
          if (preserveBottom) {
            stickToBottomRef.current = true
            setIsPinnedToBottom(true)
          }
          scrollToLatest()
          if (preserveBottom) armLayoutProtection()
        }
      }

      let cancelled = false
      scheduledFrameRef.current = {
        cancel: () => {
          cancelled = true
        },
      }
      queueMicrotask(() => {
        if (!cancelled) run()
      })
    },
    [armLayoutProtection, cancelScheduledFollow, restoreReaderPosition, scrollToLatest],
  )

  const captureScrollAnchor = useCallback((): ScrollAnchor | undefined => {
    const element = scrollRef.current
    if (element === null) return undefined
    cancelScheduledFollow()
    lastReaderScrollTopRef.current = element.scrollTop
    const top = element.getBoundingClientRect().top
    const row = [...element.querySelectorAll<HTMLElement>('[data-node-id]')].find(
      (node) => node.getBoundingClientRect().bottom > top,
    )
    return {
      ...(row?.dataset.nodeId === undefined
        ? {}
        : { nodeId: row.dataset.nodeId, nodeOffset: row.getBoundingClientRect().top - top }),
      contentHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      interactionGeneration: interactionGenerationRef.current,
      measurementAdjustment: measurementAdjustmentRef.current,
    }
  }, [cancelScheduledFollow])

  const isScrollAnchorCurrent = useCallback(
    (anchor: ScrollAnchor): boolean => anchor.interactionGeneration === interactionGenerationRef.current,
    [],
  )

  const restoreScrollAnchor = useCallback((anchor: ScrollAnchor): boolean => {
    const element = scrollRef.current
    if (element === null || anchor.interactionGeneration !== interactionGenerationRef.current) return false

    // A native gesture may have happened before its scroll event reaches
    // React. Do not overwrite that newer reader position just because an
    // older history request completed.
    const measuredDelta = measurementAdjustmentRef.current - (anchor.measurementAdjustment ?? 0)
    if (Math.abs(element.scrollTop - anchor.scrollTop - measuredDelta) > 1) return false

    const row =
      anchor.nodeId === undefined
        ? undefined
        : [...element.querySelectorAll<HTMLElement>('[data-node-id]')].find(
            (node) => node.dataset.nodeId === anchor.nodeId,
          )
    const heightDelta =
      row !== undefined && anchor.nodeOffset !== undefined
        ? row.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.nodeOffset
        : element.scrollHeight - anchor.contentHeight
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
    const baseScrollTop =
      row === undefined || anchor.nodeOffset === undefined ? anchor.scrollTop : element.scrollTop
    const nextScrollTop = Math.min(maxScrollTop, Math.max(0, baseScrollTop + heightDelta))
    internalScrollTopRef.current = nextScrollTop
    if (Math.abs(element.scrollTop - nextScrollTop) > 0.5) {
      element.scrollTop = nextScrollTop
    }
    lastReaderScrollTopRef.current = nextScrollTop
    return true
  }, [])

  const isUserScrollActive = useCallback((): boolean => userScrollActiveRef.current, [])

  const armUserScrollLock = useCallback((): void => {
    clearLayoutProtection()
    internalScrollTopRef.current = undefined
    interactionGenerationRef.current += 1
    userScrollActiveRef.current = true
    if (userScrollIdleTimerRef.current !== undefined) window.clearTimeout(userScrollIdleTimerRef.current)
    userScrollIdleTimerRef.current = window.setTimeout(() => {
      userScrollIdleTimerRef.current = undefined
      userScrollActiveRef.current = false
      scrollIdleListenerRef.current?.()
      if (stickToBottomRef.current && itemCountRef.current > 0) scheduleScrollToLatest()
    }, USER_SCROLL_IDLE_MS)
  }, [clearLayoutProtection, scheduleScrollToLatest])

  const handleScroll = useCallback((): void => {
    const element = scrollRef.current
    if (element === null || element.clientHeight <= 0) return
    if (smoothScrollActiveRef.current) {
      const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
      if (element.scrollTop >= maxScrollTop - 1) smoothScrollActiveRef.current = false
      return
    }
    const expectedScrollTop = internalScrollTopRef.current
    const isInternalScroll =
      expectedScrollTop !== undefined && Math.abs(element.scrollTop - expectedScrollTop) <= 1
    if (!isInternalScroll) internalScrollTopRef.current = undefined
    // Chromium can deliver several scroll events for the same internal write;
    // retain its expected offset until a different offset or reader gesture.
    // A measured virtual canvas can also clamp to a nonzero estimate. Limit
    // that exception to the owning consumer's guarded layout reconciliation;
    // ordinary readers and all captured physical gestures keep control.
    const viewportResized =
      viewportHeightRef.current > 0 && viewportHeightRef.current !== element.clientHeight
    viewportHeightRef.current = element.clientHeight
    const isViewportLayoutScroll = stickToBottomRef.current && viewportResized && !userScrollActiveRef.current
    if (isViewportLayoutScroll) {
      internalScrollTopRef.current = element.scrollTop
      lastReaderScrollTopRef.current = element.scrollTop
    }
    const isLayoutScroll =
      !userScrollActiveRef.current &&
      (isViewportLayoutScroll ||
        (preserveBottomOnLayoutRef.current &&
          (element.scrollTop <= 1 ||
            (options.layoutMeasurementsActive === true && stickToBottomRef.current))))
    if (!isInternalScroll && !isLayoutScroll) {
      // Scroll events are the final source of truth. They also cover input
      // paths that do not reliably expose wheel/pointer intent in a Webview.
      cancelScheduledFollow()
      // Refresh the lock for every physical scroll event. A pointer drag or
      // inertial trackpad sequence can last longer than one idle interval;
      // allowing the first timer to expire during that sequence hands control
      // back to the append follower while the reader is still moving.
      armUserScrollLock()
      lastReaderScrollTopRef.current = element.scrollTop
    }
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    // During a native gesture, only an actual arrival at the tail can
    // re-enable append-follow. Using the relaxed reader threshold here would
    // turn a small intentional scroll-away into a delayed snap-back when the
    // gesture lock expires.
    const pinThreshold = userScrollActiveRef.current ? 1 : bottomThreshold
    const atLatest =
      isLayoutScroll || (isInternalScroll ? stickToBottomRef.current : distanceFromBottom <= pinThreshold)
    stickToBottomRef.current = atLatest
    setIsPinnedToBottom((current) => (current === atLatest ? current : atLatest))
    if (!atLatest) cancelScheduledFollow()
    if (isLayoutScroll && itemCountRef.current > 0)
      scheduleScrollToLatest({ preserveBottom: true, immediate: distanceFromBottom > 1 })
    setShowJumpToLatest((current) => {
      const next = !atLatest && options.itemCount > 0
      return current === next ? current : next
    })
  }, [
    armUserScrollLock,
    bottomThreshold,
    cancelScheduledFollow,
    options.itemCount,
    options.layoutMeasurementsActive,
    scheduleScrollToLatest,
  ])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element !== null && lastReaderScrollTopRef.current === undefined)
      lastReaderScrollTopRef.current = element.scrollTop
    if (element !== null && viewportHeightRef.current <= 0) viewportHeightRef.current = element.clientHeight
    itemCountRef.current = options.itemCount
    scrollHandlerRef.current = handleScroll
    scrollIdleListenerRef.current = options.onScrollIdle
  }, [handleScroll, options.itemCount, options.onScrollIdle])

  const handleWheel = useCallback(
    (event: Pick<WheelEvent, 'deltaY'>): void => {
      if (event.deltaY === 0) return
      const element = scrollRef.current
      if (element === null) return
      // Upward input cannot leave the tail when a short conversation has no
      // scroll range. Retain follow intent as its next answer grows.
      if (event.deltaY < 0 && element.scrollHeight <= element.clientHeight) return
      smoothScrollActiveRef.current = false
      cancelScheduledFollow()
      armUserScrollLock()

      // A downward wheel at the tail has no scrollable destination and should
      // keep the append-only follow active. Every other wheel gesture is a
      // reader intent until the subsequent native scroll event recalculates
      // the exact position.
      const remainsAtLatest =
        event.deltaY > 0 && element.scrollHeight - element.scrollTop - element.clientHeight <= 1
      if (remainsAtLatest) return

      stickToBottomRef.current = false
      setIsPinnedToBottom(false)
      setShowJumpToLatest(itemCountRef.current > 0)
    },
    [armUserScrollLock, cancelScheduledFollow],
  )

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const onWheel = (event: WheelEvent): void => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        nestedScrollConsumes(element, event.target, event.deltaY)
      )
        return
      handleWheel(event)
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (
        event.button !== 0 ||
        controlOwnsKey(event.target) ||
        nestedScrollConsumes(element, event.target, 0)
      )
        return
      smoothScrollActiveRef.current = false
      cancelScheduledFollow()
      armUserScrollLock()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!SCROLL_KEYS.has(event.key)) return
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        controlOwnsKey(event.target)
      )
        return
      const direction =
        event.key === 'ArrowUp' ||
        event.key === 'PageUp' ||
        event.key === 'Home' ||
        (event.key === ' ' && event.shiftKey)
          ? -1
          : 1
      if (nestedScrollConsumes(element, event.target, direction)) return
      smoothScrollActiveRef.current = false
      cancelScheduledFollow()
      armUserScrollLock()
    }
    const onScrollEnd = (event: Event): void => {
      if (event.target !== element) return
      const wasSmoothScroll = smoothScrollActiveRef.current
      smoothScrollActiveRef.current = false
      if (!userScrollActiveRef.current && !wasSmoothScroll) return
      clearUserScrollLock()
      scrollIdleListenerRef.current?.()
      if (stickToBottomRef.current && itemCountRef.current > 0) scheduleScrollToLatest()
    }
    // Capture the gesture on the scroll owner itself, before React's delegated
    // listener and before the browser applies the native scroll offset. The
    // pointer path also covers scrollbar dragging, which has no wheel event.
    const onScroll = (event: Event): void => {
      if (event.target === element) scrollHandlerRef.current()
    }
    element.addEventListener('wheel', onWheel, { capture: true, passive: true })
    element.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
    element.addEventListener('keydown', onKeyDown, { capture: true })
    element.addEventListener('scroll', onScroll, { capture: true, passive: true })
    element.addEventListener('scrollend', onScrollEnd, { capture: true, passive: true })
    return () => {
      element.removeEventListener('wheel', onWheel, true)
      element.removeEventListener('pointerdown', onPointerDown, true)
      element.removeEventListener('keydown', onKeyDown, true)
      element.removeEventListener('scroll', onScroll, true)
      element.removeEventListener('scrollend', onScrollEnd, true)
    }
  }, [
    armUserScrollLock,
    cancelScheduledFollow,
    clearUserScrollLock,
    handleWheel,
    options.sessionId,
    scheduleScrollToLatest,
  ])

  useLayoutEffect(
    () => () => {
      clearLayoutProtection()
      clearUserScrollLock()
    },
    [clearLayoutProtection, clearUserScrollLock],
  )

  useLayoutEffect(() => {
    const sessionChanged = previousSessionRef.current !== options.sessionId
    if (sessionChanged) {
      previousSessionRef.current = options.sessionId
      cancelScheduledFollow()
      clearLayoutProtection()
      clearUserScrollLock()
      interactionGenerationRef.current += 1
      measurementAdjustmentRef.current = 0
      internalScrollTopRef.current = undefined
      lastReaderScrollTopRef.current = undefined
      viewportHeightRef.current = 0
      stickToBottomRef.current = true
      setIsPinnedToBottom(true)
      setShowJumpToLatest(false)
    } else restoreReaderPosition()
    if (stickToBottomRef.current && options.itemCount > 0)
      scheduleScrollToLatest({ preserveBottom: true, immediate: sessionChanged })
  }, [
    cancelScheduledFollow,
    clearLayoutProtection,
    clearUserScrollLock,
    options.contentKey,
    options.itemCount,
    options.sessionId,
    restoreReaderPosition,
    scheduleScrollToLatest,
  ])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return

    const content = contentRef.current
    const observedSizes = { width: 0, height: 0 }
    const viewportSizes = { width: 0, height: 0 }
    let hidden = false
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === element) {
          const { width, height } = entry.contentRect
          if (width <= 0 || height <= 0) {
            hidden = true
            continue
          }
          const revealed = hidden
          hidden = false
          const changed =
            Math.abs(width - viewportSizes.width) >= 0.5 || Math.abs(height - viewportSizes.height) >= 0.5
          const measured = viewportSizes.width > 0
          viewportSizes.width = width
          viewportSizes.height = height
          if (viewportHeightRef.current <= 0) viewportHeightRef.current = element.clientHeight
          // Notifications and in-flow helpers resize the scroll owner without
          // changing its content. Reconcile only through the existing intent
          // guard: a free reader or an active gesture always keeps control.
          if (measured && (changed || revealed) && !userScrollActiveRef.current)
            scheduleScrollToLatest({ preserveBottom: true, immediate: true })
          continue
        }
        if (entry.target !== content) continue
        const rect = entry.contentRect
        if (rect.width <= 0 || rect.height <= 0) continue
        const previous = { ...observedSizes }
        observedSizes.width = rect.width
        observedSizes.height = rect.height
        const widthChanged = Math.abs(rect.width - previous.width) >= 0.5
        const heightChanged = Math.abs(rect.height - previous.height) >= 0.5
        if (previous.width > 0 && heightChanged && !widthChanged && !userScrollActiveRef.current)
          scheduleScrollToLatest({ preserveBottom: true, immediate: true })
      }
    })
    observer.observe(element)
    if (options.observeContentSize !== false && content !== null && content !== element)
      observer.observe(content)
    return () => {
      observer.disconnect()
      cancelScheduledFollow()
    }
  }, [cancelScheduledFollow, options.observeContentSize, options.sessionId, scheduleScrollToLatest])

  useLayoutEffect(() => cancelScheduledFollow, [cancelScheduledFollow])

  return {
    scrollRef,
    contentRef,
    handleScroll,
    scrollToLatest,
    userScrollToLatest,
    userScrollToOffset,
    captureScrollAnchor,
    isScrollAnchorCurrent,
    restoreScrollAnchor,
    applyScrollAdjustment,
    isUserScrollActive,
    scheduleScrollToLatest,
    isPinnedToBottom,
    showJumpToLatest,
  }
}
