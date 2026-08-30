// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
