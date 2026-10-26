// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useScrollFollow } from './useScrollFollow.js'

describe('useScrollFollow user jump', () => {
  it('lets a captured reader gesture cancel same-turn append following', async () => {
    vi.useFakeTimers()
    const { viewport } = renderHarness()
    setScrollMetrics(viewport, 600, 1_200, 400)
    fireEvent.wheel(viewport, { deltaY: -80 })
    setScrollMetrics(viewport, 520, 1_200, 400)
    fireEvent.scroll(viewport)
    await act(async () => {
      await Promise.resolve()
    })
    expect(viewport.scrollTop).toBe(520)
    expect(screen.getByTestId('jump-state').getAttribute('data-visible')).toBe('true')
    act(() => {
      vi.runAllTimers()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(viewport.scrollTop).toBe(520)
  })

  afterEach(() => {
    cleanup()
    document.body.className = ''
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('honors the VS Code class initially and stops a smooth jump when it changes at runtime', async () => {
    stubReducedMotion(false)
    document.body.classList.add('vscode-reduce-motion')
    const { viewport, scrollTo } = renderHarness()
    setScrollMetrics(viewport, 200, 1_000, 400)
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    expect(scrollTo).not.toHaveBeenCalled()
    expect(viewport.scrollTop).toBe(600)
    await act(async () => {
      await Promise.resolve()
      document.body.classList.remove('vscode-reduce-motion')
    })
    viewport.scrollTop = 200
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    await act(async () => {
      await Promise.resolve()
      document.body.classList.add('vscode-reduce-motion')
    })
    expect(viewport.scrollTop).toBe(600)
    expect(screen.getByTestId('jump-state').getAttribute('data-visible')).toBe('false')
  })
})

function renderHarness(layoutMeasurementsActive = false): {
  viewport: HTMLDivElement
  scrollTo: ReturnType<typeof vi.fn>
} {
  function Harness(): ReactElement {
    const follow = useScrollFollow({
      contentKey: 'tail',
      itemCount: 1,
      sessionId: 'session-1',
      layoutMeasurementsActive,
    })
    return (
      <>
        <div ref={follow.scrollRef} data-testid="viewport" onScroll={follow.handleScroll}>
          <div ref={follow.contentRef} data-testid="content" />
        </div>
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
