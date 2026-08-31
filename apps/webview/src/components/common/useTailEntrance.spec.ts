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
      ({ tailId, resetKey }: { tailId: string | undefined; resetKey: string }) =>
        useTailEntrance(tailId, resetKey),
      { initialProps: { tailId: 'one', resetKey: 'session-1' } },
    )

    expect(result.current).toBeUndefined()
    rerender({ tailId: 'one', resetKey: 'session-1' })
    expect(result.current).toBeUndefined()
    rerender({ tailId: 'new-session', resetKey: 'session-2' })
    expect(result.current).toBeUndefined()
  })

  it('marks only a newly appended tail and clears it on the next frame', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', undefined)

    const { result, rerender } = renderHook(
      ({ tailId, resetKey }: { tailId: string | undefined; resetKey: string }) =>
        useTailEntrance(tailId, resetKey),
      { initialProps: { tailId: 'one', resetKey: 'session-1' } },
    )

    rerender({ tailId: 'two', resetKey: 'session-1' })
    expect(result.current).toBe('two')

    act(() => {
      vi.runOnlyPendingTimers()
    })
    expect(result.current).toBeUndefined()

    rerender({ tailId: 'three', resetKey: 'session-1' })
    expect(result.current).toBe('three')
  })
})
