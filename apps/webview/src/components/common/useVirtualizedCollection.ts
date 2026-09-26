import { useCallback, useMemo, useRef, type RefObject } from 'react'
import { defaultRangeExtractor, useVirtualizer, type Range, type VirtualItem } from '@tanstack/react-virtual'

/**
 * Keep the small-session DOM simple while bounding the expensive render tree
 * once a conversation becomes large. The boundary is a rendering policy, not
 * a visual breakpoint: callers can opt in earlier for heavyweight records.
 */
export const DEFAULT_VIRTUALIZATION_THRESHOLD = 24
export const DEFAULT_VIRTUALIZATION_PAYLOAD_THRESHOLD = 96_000
export const DEFAULT_VIRTUALIZATION_OVERSCAN = 4
const DEFAULT_ESTIMATED_ITEM_SIZE = 96
function defaultEstimateSize(): number {
  return DEFAULT_ESTIMATED_ITEM_SIZE
}

export interface VirtualizedCollectionOptions<T> {
  readonly items: readonly T[]
  readonly scrollRef: RefObject<HTMLDivElement | null>
  readonly enabled?: boolean
  readonly estimateSize?: (index: number) => number
  readonly overscan?: number
  readonly getItemKey?: (item: T, index: number) => string | number
  /** Keep the currently focused row mounted while it is outside the viewport. */
  readonly getPinnedItemIndex?: () => number | undefined
  /** Apply a measured-height anchor delta through the shared scroll owner. */
  readonly onScrollAdjustment?: (delta: number) => void
}

export interface VirtualizedCollectionResult {
  readonly enabled: boolean
  /** Whether the virtualizer has a usable viewport range for this render. */
  readonly ready: boolean
  readonly totalSize: number
  readonly virtualItems: readonly VirtualItem[]
  readonly measureElement: (element: HTMLDivElement | null) => void
}

/**
 * Shared windowing primitive for long append-only surfaces.
 *
 * The virtualizer only reads and measures the scroll owner. It forwards
 * measured-height anchor deltas to useScrollFollow and never performs a
 * lifecycle/target scroll write itself, so a list update cannot compete with
 * reader input.
 */
export function useVirtualizedCollection<T>(
  options: VirtualizedCollectionOptions<T>,
): VirtualizedCollectionResult {
  const {
    enabled: enabledOption,
    estimateSize: estimateSizeOption,
    getItemKey: getItemKeyOption,
    items,
    overscan: overscanOption,
    scrollRef,
  } = options
  const enabled = enabledOption ?? items.length >= DEFAULT_VIRTUALIZATION_THRESHOLD
  const count = enabled ? items.length : 0
  const estimateSize = estimateSizeOption ?? defaultEstimateSize
  const overscan = overscanOption ?? DEFAULT_VIRTUALIZATION_OVERSCAN
  const itemsRef = useRef(items)
  itemsRef.current = items
  const getItemKeyOptionRef = useRef(getItemKeyOption)
  getItemKeyOptionRef.current = getItemKeyOption
  const getPinnedItemIndexRef = useRef(options.getPinnedItemIndex)
  getPinnedItemIndexRef.current = options.getPinnedItemIndex
  const getItemKey = useCallback((index: number): string | number => {
    const item = itemsRef.current[index]
    return item === undefined ? index : (getItemKeyOptionRef.current?.(item, index) ?? index)
  }, [])
  const getScrollElement = useCallback(() => scrollRef.current, [scrollRef])
  const onScrollAdjustmentRef = useRef(options.onScrollAdjustment)
  onScrollAdjustmentRef.current = options.onScrollAdjustment
  const scrollToFn = useCallback(
    (_offset: number, scrollOptions: { readonly adjustments?: number }): void => {
      const adjustments = scrollOptions.adjustments
      if (adjustments === undefined || Math.abs(adjustments) <= 0.5) return
      // Ignore ordinary virtualizer lifecycle/target writes. Only forward the
      // measured-height delta; the shared scroll owner decides how to apply it.
      onScrollAdjustmentRef.current?.(adjustments)
    },
    [],
  )
  // virtual-core synchronizes its offset when it attaches and whenever the
  // collection is enabled again. Seed that offset from the scroll owner so an
  // internal lifecycle write cannot reset a reader who is already at the
  // bottom (or intentionally reading elsewhere) to zero.
  const initialOffset = useCallback(() => scrollRef.current?.scrollTop ?? 0, [scrollRef])
  const rangeExtractor = useCallback((range: Range): number[] => {
    const indexes = defaultRangeExtractor(range)
    const pinnedIndex = getPinnedItemIndexRef.current?.()
    if (
      pinnedIndex === undefined ||
      pinnedIndex < 0 ||
      pinnedIndex >= range.count ||
      indexes.includes(pinnedIndex)
    )
      return indexes
    return [...indexes, pinnedIndex].sort((left, right) => left - right)
  }, [])
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count,
    enabled,
    getScrollElement,
    estimateSize,
    getItemKey,
    initialOffset,
    overscan,
    rangeExtractor,
    scrollToFn,
  })
  const virtualItems = virtualizer.getVirtualItems()
  // A Webview can commit the conversation before flex layout has produced a
  // non-zero viewport. In that frame the virtualizer intentionally exposes no
  // range; treating that as an empty conversation makes the whole chat vanish
  // until an unrelated rerender (for example switching tasks) occurs. Keep
  // the virtualizer subscribed and let the caller render its normal flow until
  // a real range is available.
  const ready = !enabled || virtualItems.length > 0
  return useMemo(
    () => ({
      enabled,
      ready,
      totalSize: enabled ? virtualizer.getTotalSize() : 0,
      virtualItems,
      measureElement: virtualizer.measureElement,
    }),
    [enabled, ready, virtualItems, virtualizer],
  )
}
