import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

const DEFAULT_BOTTOM_THRESHOLD = 64
const USER_SCROLL_IDLE_MS = 220
const FOLLOW_INPUT_GRACE_MS = 48
const SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '])

interface ScheduledFrame {
  readonly cancel: () => void
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
}

/** A reader position captured before an older history page is inserted. */
export interface ScrollAnchor {
  readonly contentHeight: number
  readonly scrollTop: number
  readonly interactionGeneration: number
}

export interface ScrollFollowResult {
  readonly scrollRef: RefObject<HTMLDivElement | null>
  readonly contentRef: RefObject<HTMLDivElement | null>
  readonly handleScroll: () => void
  readonly scrollToLatest: () => void
  /** Move to the tail from an explicit reader action with smooth motion. */
  readonly userScrollToLatest: () => void
  /** Capture the current position for a guarded prepend restoration. */
  readonly captureScrollAnchor: () => ScrollAnchor | undefined
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
 * content updates coalesce into one delayed reconciliation; known layout
 * transitions are corrected synchronously before paint. Native reader intent
 * cancels a pending follow immediately, and the grace period gives wheel,
 * pointer, and keyboard gestures time to arrive before an append-only update
 * is allowed to move the viewport.
 */
export function useScrollFollow(options: ScrollFollowOptions): ScrollFollowResult {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const previousSessionRef = useRef(options.sessionId)
  const scheduledFrameRef = useRef<ScheduledFrame | undefined>(undefined)
  const userScrollIdleTimerRef = useRef<number | undefined>(undefined)
  const userScrollActiveRef = useRef(false)
  const interactionGenerationRef = useRef(0)
  const internalScrollTopRef = useRef<number | undefined>(undefined)
  const lastReaderScrollTopRef = useRef<number | undefined>(undefined)
  const preserveBottomOnLayoutRef = useRef(false)
  const layoutProtectionTimerRef = useRef<number | undefined>(undefined)
  const smoothScrollActiveRef = useRef(false)
  const scrollHandlerRef = useRef<() => void>(() => undefined)
  const itemCountRef = useRef(options.itemCount)
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

  const restoreReaderPosition = useCallback((allowDuringGesture = false): boolean => {
    const element = scrollRef.current
    const savedScrollTop = lastReaderScrollTopRef.current
    if (
      element === null ||
      savedScrollTop === undefined ||
      stickToBottomRef.current ||
      (userScrollActiveRef.current && !allowDuringGesture)
    )
      return false

    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
    if (savedScrollTop > 1 && maxScrollTop <= 1) return false
    const nextScrollTop = Math.min(maxScrollTop, Math.max(0, savedScrollTop))
    if (Math.abs(element.scrollTop - nextScrollTop) > 0.5) {
      internalScrollTopRef.current = nextScrollTop
      element.scrollTop = nextScrollTop
    } else internalScrollTopRef.current = undefined
    lastReaderScrollTopRef.current = nextScrollTop
    return true
  }, [])

  const applyScrollAdjustment = useCallback((delta: number): void => {
    if (!Number.isFinite(delta) || Math.abs(delta) <= 0.5) return
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
    if (isCollapsedFreeReader && maxScrollTop <= 1) return
    const nextScrollTop = Math.min(maxScrollTop, Math.max(0, baseScrollTop + delta))
    internalScrollTopRef.current = nextScrollTop
    element.scrollTop = nextScrollTop
    lastReaderScrollTopRef.current = nextScrollTop
  }, [])

  const scrollToLatest = useCallback((): void => {
    clearUserScrollLock()
    cancelScheduledFollow()
    const element = scrollRef.current
    if (element === null) return

    stickToBottomRef.current = true
    setIsPinnedToBottom(true)
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
    if (Math.abs(element.scrollTop - maxScrollTop) > 0.5) {
      internalScrollTopRef.current = maxScrollTop
      element.scrollTop = maxScrollTop
    } else internalScrollTopRef.current = undefined
    lastReaderScrollTopRef.current = maxScrollTop
    setShowJumpToLatest(false)
  }, [cancelScheduledFollow, clearUserScrollLock])

  const userScrollToLatest = useCallback((): void => {
    clearLayoutProtection()
    clearUserScrollLock()
    cancelScheduledFollow()
    const element = scrollRef.current
    if (element === null) return

    stickToBottomRef.current = true
    setIsPinnedToBottom(true)
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
    setShowJumpToLatest(false)

    const reduceMotion =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
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

  const scheduleScrollToLatest = useCallback(
    (scheduleOptions?: ScrollFollowScheduleOptions): void => {
      // A free reader may be clamped by a normal-flow/virtualized-canvas
      // transition. Restore the last observed reader position first; this
      // path never changes a free reader into tail-following mode.
      restoreReaderPosition(scheduleOptions?.preserveBottom === true)
      const preserveBottom =
        scheduleOptions?.preserveBottom === true &&
        stickToBottomRef.current &&
        !userScrollActiveRef.current &&
        itemCountRef.current > 0
      if (preserveBottom) preserveBottomOnLayoutRef.current = true
      if (preserveBottom && scheduleOptions?.immediate === true) {
        // A known layout transition runs from a layout effect or a
        // ResizeObserver callback. Correct synchronously so the browser never
        // paints its transient clamped offset before the delayed streaming
        // reconciliation can run.
        cancelScheduledFollow()
        scrollToLatest()
        armLayoutProtection()
        return
      }
      const shouldFollow = stickToBottomRef.current || preserveBottomOnLayoutRef.current
      if (userScrollActiveRef.current || !shouldFollow || itemCountRef.current === 0) return
      // Keep one coalesced reconciliation alive. Streaming updates can arrive
      // faster than a frame; resetting the timer for every update creates a
      // moving target and increases the chance of racing a native gesture.
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

      const id = window.setTimeout(run, FOLLOW_INPUT_GRACE_MS)
      scheduledFrameRef.current = { cancel: () => window.clearTimeout(id) }
    },
    [armLayoutProtection, cancelScheduledFollow, restoreReaderPosition, scrollToLatest],
  )

  const captureScrollAnchor = useCallback((): ScrollAnchor | undefined => {
    const element = scrollRef.current
    if (element === null) return undefined
    cancelScheduledFollow()
    lastReaderScrollTopRef.current = element.scrollTop
    return {
      contentHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      interactionGeneration: interactionGenerationRef.current,
    }
  }, [cancelScheduledFollow])

  const restoreScrollAnchor = useCallback((anchor: ScrollAnchor): boolean => {
    const element = scrollRef.current
    if (element === null || anchor.interactionGeneration !== interactionGenerationRef.current) return false

    // A native gesture may have happened before its scroll event reaches
    // React. Do not overwrite that newer reader position just because an
    // older history request completed.
    if (Math.abs(element.scrollTop - anchor.scrollTop) > 1) return false

    const heightDelta = element.scrollHeight - anchor.contentHeight
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
    const nextScrollTop = Math.min(maxScrollTop, Math.max(0, anchor.scrollTop + heightDelta))
    if (Math.abs(element.scrollTop - nextScrollTop) > 0.5) {
      internalScrollTopRef.current = nextScrollTop
      element.scrollTop = nextScrollTop
    } else internalScrollTopRef.current = undefined
    lastReaderScrollTopRef.current = nextScrollTop
    return true
  }, [])

  const isUserScrollActive = useCallback((): boolean => userScrollActiveRef.current, [])

  const armUserScrollLock = useCallback((): void => {
    clearLayoutProtection()
    internalScrollTopRef.current = undefined
    if (!userScrollActiveRef.current) interactionGenerationRef.current += 1
    userScrollActiveRef.current = true
    if (userScrollIdleTimerRef.current !== undefined) window.clearTimeout(userScrollIdleTimerRef.current)
    userScrollIdleTimerRef.current = window.setTimeout(() => {
      userScrollIdleTimerRef.current = undefined
      userScrollActiveRef.current = false
      if (stickToBottomRef.current && itemCountRef.current > 0) scheduleScrollToLatest()
    }, USER_SCROLL_IDLE_MS)
  }, [clearLayoutProtection, scheduleScrollToLatest])

  const handleScroll = useCallback((): void => {
    const element = scrollRef.current
    if (element === null) return
    if (smoothScrollActiveRef.current) {
      const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
      if (element.scrollTop >= maxScrollTop - 1) smoothScrollActiveRef.current = false
      return
    }
    const expectedScrollTop = internalScrollTopRef.current
    const isInternalScroll =
      expectedScrollTop !== undefined && Math.abs(element.scrollTop - expectedScrollTop) <= 1
    internalScrollTopRef.current = undefined
    if (isInternalScroll) lastReaderScrollTopRef.current = element.scrollTop
    // A layout replacement can only be identified safely when the browser
    // clamps a previously pinned reader all the way to the start. Any other
    // offset may be an intentional reader position and must release follow.
    const isLayoutScroll =
      preserveBottomOnLayoutRef.current && !userScrollActiveRef.current && element.scrollTop <= 1
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
    const atLatest = isLayoutScroll || distanceFromBottom <= pinThreshold
    stickToBottomRef.current = atLatest
    setIsPinnedToBottom((current) => (current === atLatest ? current : atLatest))
    if (!atLatest) cancelScheduledFollow()
    if (isLayoutScroll && itemCountRef.current > 0)
      scheduleScrollToLatest({ preserveBottom: true, immediate: distanceFromBottom > 1 })
    setShowJumpToLatest((current) => {
      const next = !atLatest && options.itemCount > 0
      return current === next ? current : next
    })
  }, [armUserScrollLock, bottomThreshold, cancelScheduledFollow, options.itemCount, scheduleScrollToLatest])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element !== null && lastReaderScrollTopRef.current === undefined)
      lastReaderScrollTopRef.current = element.scrollTop
    itemCountRef.current = options.itemCount
    scrollHandlerRef.current = handleScroll
  }, [handleScroll, options.itemCount])

  const handleWheel = useCallback(
    (event: Pick<WheelEvent, 'deltaY'>): void => {
      if (event.deltaY === 0) return
      smoothScrollActiveRef.current = false
      cancelScheduledFollow()
      armUserScrollLock()

      const element = scrollRef.current
      if (element === null) return
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
    const onWheel = (event: WheelEvent): void => handleWheel(event)
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return
      smoothScrollActiveRef.current = false
      cancelScheduledFollow()
      armUserScrollLock()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!SCROLL_KEYS.has(event.key)) return
      if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLInputElement) return
      smoothScrollActiveRef.current = false
      cancelScheduledFollow()
      armUserScrollLock()
    }
    const onScrollEnd = (): void => {
      smoothScrollActiveRef.current = false
      if (!userScrollActiveRef.current) return
      clearUserScrollLock()
      if (stickToBottomRef.current && itemCountRef.current > 0) scheduleScrollToLatest()
    }
    // Capture the gesture on the scroll owner itself, before React's delegated
    // listener and before the browser applies the native scroll offset. The
    // pointer path also covers scrollbar dragging, which has no wheel event.
    const onScroll = (): void => scrollHandlerRef.current()
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
  }, [armUserScrollLock, cancelScheduledFollow, clearUserScrollLock, handleWheel, scheduleScrollToLatest])

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
      stickToBottomRef.current = true
      setIsPinnedToBottom(true)
      setShowJumpToLatest(false)
    } else restoreReaderPosition(true)
    if (stickToBottomRef.current && options.itemCount > 0)
      scheduleScrollToLatest({ preserveBottom: true, immediate: sessionChanged })
  }, [
    options.contentKey,
    options.itemCount,
    options.sessionId,
    restoreReaderPosition,
    scheduleScrollToLatest,
  ])

  useLayoutEffect(() => {
    if (options.observeContentSize === false) return
    const element = scrollRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return

    const content = contentRef.current
    if (content === null || content === element) return

    const observedSizes = { width: 0, height: 0 }
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target !== content) continue
        const rect = entry.contentRect
        const previous = { ...observedSizes }
        observedSizes.width = rect.width
        observedSizes.height = rect.height
        const widthChanged = Math.abs(rect.width - previous.width) >= 0.5
        const heightChanged = Math.abs(rect.height - previous.height) >= 0.5
        if (previous.width > 0 && heightChanged && !widthChanged)
          scheduleScrollToLatest({ preserveBottom: true, immediate: true })
      }
    })
    // Only content changes can require append-to-tail reconciliation. The
    // viewport itself changes when the composer, inspector, or host chrome
    // resizes; observing it creates a second path that can move a reader
    // while they are scrolling.
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
    captureScrollAnchor,
    restoreScrollAnchor,
    applyScrollAdjustment,
    isUserScrollActive,
    scheduleScrollToLatest,
    isPinnedToBottom,
    showJumpToLatest,
  }
}
