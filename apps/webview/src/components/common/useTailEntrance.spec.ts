// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTailEntrance } from './useTailEntrance.js'

describe('useTailEntrance', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('does not animate the initial, prepended, or reset collection', () => {
    const { result, rerender } = renderHook(
      ({ ids, resetKey }: { ids: readonly string[]; resetKey: string }) => useTailEntrance(ids, resetKey),
      { initialProps: { ids: ['one'], resetKey: 'session-1' } },
    )

    expect(result.current).toBeUndefined()
    rerender({ ids: ['zero', 'one'], resetKey: 'session-1' })
    expect(result.current).toBeUndefined()
    rerender({ ids: ['new-session'], resetKey: 'session-2' })
    expect(result.current).toBeUndefined()
  })

  it('marks only a newly appended tail and clears it on the next frame', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', undefined)

    const { result, rerender } = renderHook(
      ({ ids, resetKey }: { ids: readonly string[]; resetKey: string }) => useTailEntrance(ids, resetKey),
      { initialProps: { ids: ['one'], resetKey: 'session-1' } },
    )

    rerender({ ids: ['one', 'two'], resetKey: 'session-1' })
    expect(result.current).toBe('two')

    act(() => {
      vi.runOnlyPendingTimers()
    })
    expect(result.current).toBeUndefined()

    rerender({ ids: ['one', 'two', 'three'], resetKey: 'session-1' })
    expect(result.current).toBe('three')
  })
})
