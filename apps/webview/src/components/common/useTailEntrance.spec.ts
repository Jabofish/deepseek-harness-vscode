// @vitest-environment jsdom

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTailEntrance } from './useTailEntrance.js'

describe('useTailEntrance', () => {
  afterEach(() => vi.unstubAllGlobals())

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

  it('marks a newly appended tail until a later tail replaces it', () => {
    const { result, rerender } = renderHook(
      ({ tailId, resetKey }: { tailId: string | undefined; resetKey: string }) =>
        useTailEntrance(tailId, resetKey),
      { initialProps: { tailId: 'one', resetKey: 'session-1' } },
    )

    rerender({ tailId: 'two', resetKey: 'session-1' })
    expect(result.current).toBe('two')

    rerender({ tailId: 'three', resetKey: 'session-1' })
    expect(result.current).toBe('three')
  })

  it('does not animate tail changes while the stream is active', () => {
    const { result, rerender } = renderHook(
      ({ tailId, resetKey, suppress }: { tailId: string | undefined; resetKey: string; suppress: boolean }) =>
        useTailEntrance(tailId, resetKey, suppress),
      { initialProps: { tailId: 'one', resetKey: 'session-1', suppress: true } },
    )

    rerender({ tailId: 'two', resetKey: 'session-1', suppress: true })
    expect(result.current).toBeUndefined()

    rerender({ tailId: 'two', resetKey: 'session-1', suppress: false })
    expect(result.current).toBeUndefined()

    rerender({ tailId: 'three', resetKey: 'session-1', suppress: false })
    expect(result.current).toBe('three')
  })
})
