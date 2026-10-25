// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useScrollFollow } from './useScrollFollow.js'

describe('useScrollFollow user jump', () => {
  it('follows appended content before any fixed timer is advanced', async () => {
    vi.useFakeTimers()
    function Stream({ revision }: { revision: number }): ReactElement {
      const follow = useScrollFollow({
        contentKey: revision,
        itemCount: 1,
        sessionId: 'live',
        observeContentSize: false,
      })
      return (
        <div ref={follow.scrollRef} data-testid="live-viewport" onScroll={follow.handleScroll}>
          <div ref={follow.contentRef} />
        </div>
      )
    }
    const view = render(<Stream revision={0} />)
    const viewport = screen.getByTestId<HTMLDivElement>('live-viewport')
    setScrollMetrics(viewport, 600, 1_000, 400)
    await act(async () => {
      await Promise.resolve()
    })
    setScrollMetrics(viewport, 600, 1_200, 400)
    view.rerender(<Stream revision={1} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(viewport.scrollTop).toBe(800)
  })

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

  it('uses smooth scrolling for an explicit jump when motion is allowed', () => {
    stubReducedMotion(false)
    const { viewport, scrollTo } = renderHarness()
    setScrollMetrics(viewport, 200, 1_000, 400)

    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))

    expect(scrollTo).toHaveBeenCalledWith({ top: 600, behavior: 'smooth' })
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
    expect(scrollTo).toHaveBeenCalledOnce()
    await act(async () => {
      await Promise.resolve()
      document.body.classList.add('vscode-reduce-motion')
    })
    expect(viewport.scrollTop).toBe(600)
    expect(screen.getByTestId('jump-state').getAttribute('data-visible')).toBe('false')
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

  it('keeps a pinned tail visible when a notification changes viewport height', () => {
    vi.useFakeTimers()
    const resize = stubViewportResize()
    const { viewport } = renderHarness()
    setScrollMetrics(viewport, 600, 1_000, 400)
    act(() => resize(viewport, 400))

    setScrollMetrics(viewport, 600, 1_000, 300)
    act(() => resize(viewport, 300))
    expect(viewport.scrollTop).toBe(700)
    expect(screen.getByTestId('jump-state').getAttribute('data-visible')).toBe('false')

    setScrollMetrics(viewport, 700, 1_000, 400)
    act(() => resize(viewport, 400))
    expect(viewport.scrollTop).toBe(600)
  })

  it('does not mistake a native height clamp before ResizeObserver for a reader gesture', () => {
    vi.useFakeTimers()
    const resize = stubViewportResize()
    const { viewport } = renderHarness()
    const content = screen.getByTestId('content')
    setScrollMetrics(viewport, 600, 1_000, 400)
    act(() => {
      resize(viewport, 400)
      resize(content, 1_000)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Preserve layout' }))
    act(() => {
      vi.advanceTimersByTime(250)
    })
    // A shrinking composer expands the viewport. Chromium clamps the old tail
    // before the resize notification, without any wheel or pointer gesture.
    setScrollMetrics(viewport, 550, 1_000, 450)
    fireEvent.scroll(viewport)
    setScrollMetrics(viewport, 550, 1_100, 450)
    act(() => resize(content, 1_100))
    expect(viewport.scrollTop).toBe(650)
    expect(screen.getByTestId('jump-state').getAttribute('data-visible')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Preserve layout' }))
    fireEvent.scroll(viewport)
    fireEvent.scroll(viewport)
    setScrollMetrics(viewport, 650, 1_200, 450)
    act(() => resize(content, 1_200))
    expect(viewport.scrollTop).toBe(750)
  })

  it('keeps following after nonzero measurement clamps and duplicate Chromium scroll events', () => {
    vi.useFakeTimers()
    const { viewport } = renderHarness(true)
    setScrollMetrics(viewport, 600, 1_000, 400)
    fireEvent.click(screen.getByRole('button', { name: 'Preserve layout' }))
    viewport.scrollTop = 350
    fireEvent.scroll(viewport)
    fireEvent.scroll(viewport)
    act(() => {
      vi.runAllTimers()
    })
    expect(viewport.scrollTop).toBe(600)
    fireEvent.scroll(viewport)
    fireEvent.scroll(viewport)
    expect(screen.getByTestId('jump-state').getAttribute('data-visible')).toBe('false')
    fireEvent.wheel(viewport, { deltaY: -60 })
    viewport.scrollTop = 350
    fireEvent.scroll(viewport)
    act(() => {
      vi.runAllTimers()
    })
    expect(viewport.scrollTop).toBe(350)
    expect(screen.getByTestId('jump-state').getAttribute('data-visible')).toBe('true')
  })

  it('preserves a free reader across notification resizing', () => {
    vi.useFakeTimers()
    const resize = stubViewportResize()
    const { viewport } = renderHarness()
    setScrollMetrics(viewport, 200, 1_000, 400)
    act(() => resize(viewport, 400))
    fireEvent.scroll(viewport)
    act(() => {
      vi.runAllTimers()
    })

    setScrollMetrics(viewport, 200, 1_000, 300)
    act(() => resize(viewport, 300))
    expect(viewport.scrollTop).toBe(200)
    expect(screen.getByTestId('jump-state').getAttribute('data-visible')).toBe('true')
  })

  it('does not overwrite a gesture before its native scroll event arrives', () => {
    vi.useFakeTimers()
    const resize = stubViewportResize()
    const { viewport } = renderHarness()
    setScrollMetrics(viewport, 600, 1_000, 400)
    act(() => resize(viewport, 400))
    const content = screen.getByTestId('content')
    act(() => resize(content, 1_000))
    fireEvent.wheel(viewport, { deltaY: -30 })
    setScrollMetrics(viewport, 500, 1_400, 300)

    act(() => {
      resize(viewport, 300)
      resize(content, 1_400)
    })
    expect(viewport.scrollTop).toBe(500)
    fireEvent.scroll(viewport)
    act(() => {
      vi.runAllTimers()
    })
    expect(viewport.scrollTop).toBe(500)
    expect(screen.getByTestId('jump-state').getAttribute('data-visible')).toBe('true')
  })
})

function stubViewportResize(): (target: Element, height: number) => void {
  let notify: ((entry: ResizeObserverEntry) => void) | undefined
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        notify = (entry) => callback([entry], this)
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
  return (target, height) => {
    if (notify === undefined) throw new Error('Viewport is not observed')
    notify({ target, contentRect: new DOMRect(0, 0, 240, height) } as ResizeObserverEntry)
  }
}

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
