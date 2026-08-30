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
  /** Capture the current position for a guarded prepend restoration. */
  readonly captureScrollAnchor: () => ScrollAnchor | undefined
  /** Restore a captured prepend position only while the reader is still there. */
  readonly restoreScrollAnchor: (anchor: ScrollAnchor) => boolean
  /** Reconcile after a consumer-owned layout measurement changes its height. */
  readonly scheduleScrollToLatest: () => void
  /** Whether the browser is currently following the append-only tail. */
  readonly isPinnedToBottom: boolean
  readonly showJumpToLatest: boolean
}

/**
 * Owns the scroll contract shared by append-only conversation surfaces.
 *
 * There is deliberately one scheduled writer for the scroll position. Resize
 * and content updates coalesce into one delayed reconciliation, while native
 * reader intent cancels a pending follow immediately. The grace period gives
 * wheel, pointer, and keyboard gestures time to arrive before an append-only
 * update is allowed to move the viewport.
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
    setShowJumpToLatest(false)
  }, [cancelScheduledFollow, clearUserScrollLock])

  const scheduleScrollToLatest = useCallback((): void => {
    if (userScrollActiveRef.current || !stickToBottomRef.current || itemCountRef.current === 0) return
    // Keep one coalesced reconciliation alive. Streaming updates can arrive
    // faster than a frame; resetting the timer for every update creates a
    // moving target and increases the chance of racing a native gesture.
    if (scheduledFrameRef.current !== undefined) return
    const scheduledGeneration = interactionGenerationRef.current

    const run = (): void => {
      scheduledFrameRef.current = undefined
      if (
        scheduledGeneration === interactionGenerationRef.current &&
        !userScrollActiveRef.current &&
        stickToBottomRef.current
      )
        scrollToLatest()
    }

    const id = window.setTimeout(run, FOLLOW_INPUT_GRACE_MS)
    scheduledFrameRef.current = { cancel: () => window.clearTimeout(id) }
  }, [scrollToLatest])

  const captureScrollAnchor = useCallback((): ScrollAnchor | undefined => {
    const element = scrollRef.current
    if (element === null) return undefined
    cancelScheduledFollow()
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
    return true
  }, [])

  const armUserScrollLock = useCallback((): void => {
    internalScrollTopRef.current = undefined
    if (!userScrollActiveRef.current) interactionGenerationRef.current += 1
    userScrollActiveRef.current = true
    if (userScrollIdleTimerRef.current !== undefined) window.clearTimeout(userScrollIdleTimerRef.current)
    userScrollIdleTimerRef.current = window.setTimeout(() => {
      userScrollIdleTimerRef.current = undefined
      userScrollActiveRef.current = false
      if (stickToBottomRef.current && itemCountRef.current > 0) scheduleScrollToLatest()
    }, USER_SCROLL_IDLE_MS)
  }, [scheduleScrollToLatest])

  const handleScroll = useCallback((): void => {
    const element = scrollRef.current
    if (element === null) return
    const expectedScrollTop = internalScrollTopRef.current
    const isInternalScroll =
      expectedScrollTop !== undefined && Math.abs(element.scrollTop - expectedScrollTop) <= 1
    internalScrollTopRef.current = undefined
    if (!isInternalScroll) {
      // Scroll events are the final source of truth. They also cover input
      // paths that do not reliably expose wheel/pointer intent in a Webview.
      cancelScheduledFollow()
      // Refresh the lock for every physical scroll event. A pointer drag or
      // inertial trackpad sequence can last longer than one idle interval;
      // allowing the first timer to expire during that sequence hands control
      // back to the append follower while the reader is still moving.
      armUserScrollLock()
    }
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    // During a native gesture, only an actual arrival at the tail can
    // re-enable append-follow. Using the relaxed reader threshold here would
    // turn a small intentional scroll-away into a delayed snap-back when the
    // gesture lock expires.
    const pinThreshold = userScrollActiveRef.current ? 1 : bottomThreshold
    const atLatest = distanceFromBottom <= pinThreshold
    stickToBottomRef.current = atLatest
    setIsPinnedToBottom((current) => (current === atLatest ? current : atLatest))
    if (!atLatest) cancelScheduledFollow()
    setShowJumpToLatest((current) => {
      const next = !atLatest && options.itemCount > 0
      return current === next ? current : next
    })
  }, [armUserScrollLock, bottomThreshold, cancelScheduledFollow, options.itemCount])

  useLayoutEffect(() => {
    itemCountRef.current = options.itemCount
    scrollHandlerRef.current = handleScroll
  }, [handleScroll, options.itemCount])

  const handleWheel = useCallback(
    (event: Pick<WheelEvent, 'deltaY'>): void => {
      if (event.deltaY === 0) return
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
      if (event.pointerType === 'mouse' && event.target !== element) return
      cancelScheduledFollow()
      armUserScrollLock()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!SCROLL_KEYS.has(event.key)) return
      if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLInputElement) return
      cancelScheduledFollow()
      armUserScrollLock()
    }
    const onScrollEnd = (): void => {
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

  useLayoutEffect(() => clearUserScrollLock, [clearUserScrollLock])

  useLayoutEffect(() => {
    const sessionChanged = previousSessionRef.current !== options.sessionId
    if (sessionChanged) {
      previousSessionRef.current = options.sessionId
      stickToBottomRef.current = true
      setIsPinnedToBottom(true)
      setShowJumpToLatest(false)
    }
    if (stickToBottomRef.current && options.itemCount > 0) scheduleScrollToLatest()
  }, [options.contentKey, options.itemCount, options.sessionId, scheduleScrollToLatest])

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
        if (previous.width > 0 && heightChanged && !widthChanged) scheduleScrollToLatest()
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
  }, [cancelScheduledFollow, options.observeContentSize, scheduleScrollToLatest])

  useLayoutEffect(() => cancelScheduledFollow, [cancelScheduledFollow])

  return {
    scrollRef,
    contentRef,
    handleScroll,
    scrollToLatest,
    captureScrollAnchor,
    restoreScrollAnchor,
    scheduleScrollToLatest,
    isPinnedToBottom,
    showJumpToLatest,
  }
}
