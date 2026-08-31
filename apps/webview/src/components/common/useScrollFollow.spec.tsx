// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useScrollFollow } from './useScrollFollow.js'

describe('useScrollFollow user jump', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('uses smooth scrolling for an explicit jump when motion is allowed', () => {
    stubReducedMotion(false)
    const { viewport, scrollTo } = renderHarness()
    setScrollMetrics(viewport, 200, 1_000, 400)

    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))

    expect(scrollTo).toHaveBeenCalledWith({ top: 600, behavior: 'smooth' })
  })

  it('uses an immediate jump when reduced motion is enabled', () => {
    stubReducedMotion(true)
    const { viewport, scrollTo } = renderHarness()
    setScrollMetrics(viewport, 200, 1_000, 400)

    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))

    expect(scrollTo).not.toHaveBeenCalled()
    expect(viewport.scrollTop).toBe(600)
  })

  it('does not let intermediate native smooth-scroll events re-arm the reader jump', () => {
    stubReducedMotion(false)
    const { viewport } = renderHarness()
    setScrollMetrics(viewport, 200, 1_000, 400)
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))

    viewport.scrollTop = 350
    fireEvent.scroll(viewport)
    expect(screen.getByTestId('jump-state').getAttribute('data-visible')).toBe('false')

    fireEvent.wheel(viewport, { deltaY: -30 })
    expect(screen.getByTestId('jump-state').getAttribute('data-visible')).toBe('true')
  })

  it('restores ordinary reader semantics after the smooth jump settles', () => {
    stubReducedMotion(false)
    const { viewport } = renderHarness()
    setScrollMetrics(viewport, 200, 1_000, 400)
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))

    // The native smooth scroll settles at the tail: the arrival event clears
    // the internal smooth-scroll flag without arming a reader lock.
    viewport.scrollTop = 600
    fireEvent.scroll(viewport)
    expect(screen.getByTestId('jump-state').getAttribute('data-visible')).toBe('false')

    // A later genuine user scroll away behaves exactly as before.
    viewport.scrollTop = 200
    fireEvent.scroll(viewport)
    expect(screen.getByTestId('jump-state').getAttribute('data-visible')).toBe('true')
  })

  it('does not treat a browser clamp during layout reconciliation as reader input', () => {
    vi.useFakeTimers()
    const { viewport } = renderHarness()
    setScrollMetrics(viewport, 600, 1_000, 400)

    // The reader starts pinned at the tail. A virtual canvas switch can clamp
    // the current offset before its measured height is reconciled. The layout
    // reconciliation must repair it synchronously, before the next paint.
    viewport.scrollTop = 0
    fireEvent.click(screen.getByRole('button', { name: 'Preserve layout' }))
    expect(viewport.scrollTop).toBe(600)
    fireEvent.scroll(viewport)

    act(() => {
      vi.runAllTimers()
    })

    expect(viewport.scrollTop).toBe(600)
    expect(screen.getByTestId('jump-state').getAttribute('data-visible')).toBe('false')

    // Once a real gesture arrives, the temporary layout protection must no
    // longer be able to move the reader back to the tail.
    fireEvent.wheel(viewport, { deltaY: -30 })
    expect(screen.getByTestId('jump-state').getAttribute('data-visible')).toBe('true')
  })

  it('does not pull a free reader to the top when layout briefly clamps it', () => {
    vi.useFakeTimers()
    const { viewport } = renderHarness()
    setScrollMetrics(viewport, 640, 2_000, 400)

    fireEvent.wheel(viewport, { deltaY: -30 })
    viewport.scrollTop = 640
    fireEvent.scroll(viewport)
    expect(screen.getByTestId('jump-state').getAttribute('data-visible')).toBe('true')

    // A normal-flow/virtualized transition can transiently report the top
    // even though the reader was in the middle. The next layout reconciliation
    // must restore that reader position, never follow the tail.
    viewport.scrollTop = 0
    fireEvent.click(screen.getByRole('button', { name: 'Preserve layout' }))
    expect(viewport.scrollTop).toBe(640)
    fireEvent.scroll(viewport)
    act(() => {
      vi.runAllTimers()
    })

    expect(viewport.scrollTop).toBe(640)
    expect(screen.getByTestId('jump-state').getAttribute('data-visible')).toBe('true')
  })

  it('does not reinterpret a middle reader position as a layout clamp', () => {
    vi.useFakeTimers()
    const { viewport } = renderHarness()
    setScrollMetrics(viewport, 600, 2_000, 400)

    // Arm the short layout-protection window while the reader is pinned, then
    // deliver a middle position. It is still an intentional reader position.
    fireEvent.click(screen.getByRole('button', { name: 'Preserve layout' }))
    viewport.scrollTop = 700
    fireEvent.scroll(viewport)
    act(() => {
      vi.runAllTimers()
    })

    expect(viewport.scrollTop).toBe(700)
    expect(screen.getByTestId('jump-state').getAttribute('data-visible')).toBe('true')
  })
})

function renderHarness(): { viewport: HTMLDivElement; scrollTo: ReturnType<typeof vi.fn> } {
  function Harness(): ReactElement {
    const follow = useScrollFollow({ contentKey: 'tail', itemCount: 1, sessionId: 'session-1' })
    return (
      <>
        <div ref={follow.scrollRef} data-testid="viewport" onScroll={follow.handleScroll} />
        <button type="button" onClick={follow.userScrollToLatest}>
          Jump to latest
        </button>
        <button
          type="button"
          onClick={() => follow.scheduleScrollToLatest({ preserveBottom: true, immediate: true })}
        >
          Preserve layout
        </button>
        <output data-testid="jump-state" data-visible={follow.showJumpToLatest} />
      </>
    )
  }

  render(<Harness />)
  const viewport = screen.getByTestId<HTMLDivElement>('viewport')
  const scrollTo = vi.fn()
  viewport.scrollTo = scrollTo
  viewport.scrollTop = 200
  return { viewport, scrollTo }
}

function setScrollMetrics(
  element: HTMLDivElement,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): void {
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => (scrollTop = value),
  })
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => clientHeight })
}

function stubReducedMotion(matches: boolean): void {
  vi.stubGlobal('matchMedia', () => ({
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}
