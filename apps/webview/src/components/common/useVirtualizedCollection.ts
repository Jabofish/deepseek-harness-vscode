import { useCallback, useMemo, type RefObject } from 'react'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'

/**
 * Keep the small-session DOM simple while bounding the expensive render tree
 * once a conversation becomes large. The boundary is a rendering policy, not
 * a visual breakpoint: callers can opt in earlier for heavyweight records.
 */
export const DEFAULT_VIRTUALIZATION_THRESHOLD = 24
export const DEFAULT_VIRTUALIZATION_PAYLOAD_THRESHOLD = 96_000
export const DEFAULT_VIRTUALIZATION_OVERSCAN = 4
const DEFAULT_ESTIMATED_ITEM_SIZE = 96
const NEVER_ADJUST_SCROLL_POSITION = (): boolean => false

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
}

export interface VirtualizedCollectionResult {
  readonly enabled: boolean
  readonly totalSize: number
  readonly virtualItems: readonly VirtualItem[]
  readonly measureElement: (element: HTMLDivElement | null) => void
}

/**
 * Shared windowing primitive for long append-only surfaces.
 *
 * The virtualizer only reads and measures the scroll owner. It does not own
 * scrollTop writes; that remains the responsibility of useScrollFollow. This
 * separation is what prevents a list update from competing with reader input.
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
  const getItemKey = useCallback(
    (index: number): string | number => {
      const item = items[index]
      return item === undefined ? index : (getItemKeyOption?.(item, index) ?? index)
    },
    [getItemKeyOption, items],
  )
  const getScrollElement = useCallback(() => scrollRef.current, [scrollRef])
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count,
    enabled,
    getScrollElement,
    estimateSize,
    getItemKey,
    overscan,
  })
  // The current virtual-core adapter exposes this as an instance strategy
  // rather than a React hook option. Keep the collection read/measure-only:
  // useScrollFollow is the sole scrollTop writer, so a late row measurement
  // can never compete with a native reader gesture or create a correction loop.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = NEVER_ADJUST_SCROLL_POSITION
  const virtualItems = virtualizer.getVirtualItems()
  return useMemo(
    () => ({
      enabled,
      totalSize: enabled ? virtualizer.getTotalSize() : 0,
      virtualItems,
      measureElement: virtualizer.measureElement,
    }),
    [enabled, virtualItems, virtualizer],
  )
}
