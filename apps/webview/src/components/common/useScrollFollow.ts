import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

const DEFAULT_BOTTOM_THRESHOLD = 64

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
}

export interface ScrollFollowResult {
  readonly scrollRef: RefObject<HTMLDivElement | null>
  readonly contentRef: RefObject<HTMLDivElement | null>
  readonly handleScroll: () => void
  readonly scrollToLatest: () => void
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
 * and content updates coalesce into one animation-frame reconciliation, while
 * a user scroll cancels a pending follow immediately. This keeps responsive
 * reflow and streaming updates from fighting over the same scroll owner.
 */
export function useScrollFollow(options: ScrollFollowOptions): ScrollFollowResult {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const previousSessionRef = useRef(options.sessionId)
  const scheduledFrameRef = useRef<ScheduledFrame | undefined>(undefined)
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const bottomThreshold = options.bottomThreshold ?? DEFAULT_BOTTOM_THRESHOLD

  const cancelScheduledFollow = useCallback((): void => {
    const scheduled = scheduledFrameRef.current
    if (scheduled === undefined) return
    scheduled.cancel()
    scheduledFrameRef.current = undefined
  }, [])

  const scrollToLatest = useCallback((): void => {
    cancelScheduledFollow()
    const element = scrollRef.current
    if (element === null) return

    stickToBottomRef.current = true
    setIsPinnedToBottom(true)
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
    if (Math.abs(element.scrollTop - maxScrollTop) > 0.5) element.scrollTop = maxScrollTop
    setShowJumpToLatest(false)
  }, [cancelScheduledFollow])

  const scheduleScrollToLatest = useCallback((): void => {
    if (!stickToBottomRef.current || options.itemCount === 0) return
    cancelScheduledFollow()

    const run = (): void => {
      scheduledFrameRef.current = undefined
      if (stickToBottomRef.current) scrollToLatest()
    }

    if (typeof window.requestAnimationFrame === 'function') {
      const id = window.requestAnimationFrame(run)
      scheduledFrameRef.current = { cancel: () => window.cancelAnimationFrame(id) }
      return
    }

    const id = window.setTimeout(run, 0)
    scheduledFrameRef.current = { cancel: () => window.clearTimeout(id) }
  }, [cancelScheduledFollow, options.itemCount, scrollToLatest])

  const handleScroll = useCallback((): void => {
    const element = scrollRef.current
    if (element === null) return
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    const atLatest = distanceFromBottom <= bottomThreshold
    stickToBottomRef.current = atLatest
    setIsPinnedToBottom((current) => (current === atLatest ? current : atLatest))
    if (!atLatest) cancelScheduledFollow()
    setShowJumpToLatest((current) => {
      const next = !atLatest && options.itemCount > 0
      return current === next ? current : next
    })
  }, [bottomThreshold, cancelScheduledFollow, options.itemCount])

  useLayoutEffect(() => {
    const sessionChanged = previousSessionRef.current !== options.sessionId
    if (sessionChanged) {
      previousSessionRef.current = options.sessionId
      stickToBottomRef.current = true
      setIsPinnedToBottom(true)
      setShowJumpToLatest(false)
    }
    if (stickToBottomRef.current && options.itemCount > 0) scheduleScrollToLatest()
    return cancelScheduledFollow
  }, [
    cancelScheduledFollow,
    options.contentKey,
    options.itemCount,
    options.sessionId,
    scheduleScrollToLatest,
  ])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return

    const observedSizes = new WeakMap<Element, { readonly width: number; readonly height: number }>()
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const rect = entry.contentRect
        const previous = observedSizes.get(entry.target)
        observedSizes.set(entry.target, { width: rect.width, height: rect.height })
        if (
          previous !== undefined &&
          (Math.abs(rect.width - previous.width) >= 0.5 || Math.abs(rect.height - previous.height) >= 0.5)
        )
          scheduleScrollToLatest()
      }
    })
    observer.observe(element)
    if (contentRef.current !== null && contentRef.current !== element) observer.observe(contentRef.current)
    return () => {
      observer.disconnect()
      cancelScheduledFollow()
    }
  }, [cancelScheduledFollow, scheduleScrollToLatest])

  return {
    scrollRef,
    contentRef,
    handleScroll,
    scrollToLatest,
    scheduleScrollToLatest,
    isPinnedToBottom,
    showJumpToLatest,
  }
}
