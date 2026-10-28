// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useScrollFollow, type ScrollFollowResult } from './useScrollFollow.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe.each(['flow', 'virtualized'])('%s conversation scroll intent', (surface) => {
  const openConversation = (): Promise<ConversationScenario> => conversation(surface === 'virtualized')
  it('keeps following after upward wheel input in a conversation that still fits the viewport', async () => {
    const reader = await conversation(surface === 'virtualized', true)
    reader.beginGesture('wheel')
    reader.append()
    reader.append()
    reader.endGesture()
    await reader.settle()
    expect(reader.atLatest).toBe(true)
    expect(reader.follow.showJumpToLatest).toBe(false)
  })
  it('opens the incoming session at its tail even during an outgoing reader gesture', async () => {
    const reader = await openConversation()
    reader.readEarlier()
    reader.switchSession()
    await reader.settle()
    expect(reader.atLatest).toBe(true)
    expect(reader.follow.showJumpToLatest).toBe(false)
  })

  it('invalidates pending history restoration when switching sessions', async () => {
    const reader = await openConversation()
    reader.readEarlier()
    const anchor = reader.follow.captureScrollAnchor()!
    reader.switchSession()
    expect(reader.follow.isScrollAnchorCurrent(anchor)).toBe(false)
    expect(reader.follow.restoreScrollAnchor(anchor)).toBe(false)
  })

  it('lets the incoming reader take control after replacing the session scroll surface', async () => {
    const reader = await openConversation()
    reader.switchSession()
    await reader.settle()
    reader.readEarlier()
    reader.append()
    reader.endGesture()
    await reader.settle()
    expect(reader.atLatest).toBe(false)
    expect(reader.follow.showJumpToLatest).toBe(true)
  })

  it.each(['wheel', 'scrollbar', 'keyboard'] as const)(
    'keeps a new %s position when output arrives before its scroll event',
    async (gesture) => {
      const reader = await openConversation()
      reader.readEarlier()
      reader.endGesture()
      reader.beginGesture(gesture)
      reader.moveEarlier()
      const intendedPosition = reader.position
      reader.append()
      await reader.settle()
      expect(reader.position).toBe(intendedPosition)
      reader.deliverScroll()
      reader.endGesture()
      await reader.settle()
      expect(reader.position).toBe(intendedPosition)
      expect(reader.follow.showJumpToLatest).toBe(true)
    },
  )

  it('lets a smooth jump finish before reconciling newly streamed output', async () => {
    const reader = await openConversation()
    reader.readEarlier()
    reader.endGesture()
    reader.jump()
    const start = reader.position
    reader.append()
    await reader.settle()
    expect(reader.position).toBe(start)
    reader.finishSmoothJump()
    await reader.settle()
    expect(reader.atLatest).toBe(true)
    expect(reader.follow.showJumpToLatest).toBe(false)
  })

  it('keeps a smooth jump intact when a late image or viewport resize triggers measurement', async () => {
    const reader = await openConversation()
    reader.readEarlier()
    reader.endGesture()
    reader.jump()
    const start = reader.position
    reader.growContent()
    await reader.settle()
    expect(reader.position).toBe(start)
    reader.finishSmoothJump()
    await reader.settle()
    expect(reader.atLatest).toBe(true)
  })

  it('does not let virtual row measurements interrupt a smooth jump', async () => {
    const reader = await openConversation()
    reader.readEarlier()
    reader.endGesture()
    reader.jump()
    const start = reader.position
    reader.measureEarlierGrowth()
    expect(reader.position).toBe(start)
    reader.finishSmoothJump()
    await reader.settle()
    expect(reader.atLatest).toBe(true)
  })

  it('opens the incoming session at its tail during an outgoing smooth jump', async () => {
    const reader = await openConversation()
    reader.readEarlier()
    reader.endGesture()
    reader.jump()
    reader.switchSession()
    await reader.settle()
    expect(reader.atLatest).toBe(true)
  })

  it('rejects history restoration after new input even before its scroll event arrives', async () => {
    const reader = await openConversation()
    reader.readEarlier()
    const anchor = reader.follow.captureScrollAnchor()!
    reader.beginGesture('wheel')
    expect(reader.follow.isScrollAnchorCurrent(anchor)).toBe(false)
    expect(reader.follow.restoreScrollAnchor(anchor)).toBe(false)
  })

  it('keeps restored history anchored when unchanged layout precedes native scroll delivery', async () => {
    const reader = await openConversation()
    reader.readEarlier()
    reader.endGesture()
    const anchor = reader.follow.captureScrollAnchor()!
    reader.growContent()
    act(() => expect(reader.follow.restoreScrollAnchor(anchor)).toBe(true))
    const restoredPosition = reader.position
    reader.reconcileLayout()
    reader.deliverScroll()
    expect(reader.position).toBe(restoredPosition)
    expect(reader.follow.isScrollAnchorCurrent(anchor)).toBe(true)
    expect(reader.follow.isPinnedToBottom).toBe(false)
  })

  it('lets a fresh reader gesture interrupt a smooth jump permanently', async () => {
    const reader = await openConversation()
    reader.readEarlier()
    reader.endGesture()
    reader.jump()
    reader.readEarlier()
    const intendedPosition = reader.position
    reader.append()
    reader.endGesture()
    await reader.settle()
    expect(reader.position).toBe(intendedPosition)
    expect(reader.follow.showJumpToLatest).toBe(true)
  })

  it.each(['shorter', 'empty'] as const)(
    'restores a free reader after a temporarily %s canvas settles',
    async (canvas) => {
      const reader = await openConversation()
      reader.readEarlier()
      reader.endGesture()
      const intendedPosition = reader.position
      reader.withTemporaryCanvas(canvas, () => {
        reader.reconcileLayout()
        reader.deliverScroll()
        expect(reader.follow.isPinnedToBottom).toBe(false)
      })
      reader.reconcileLayout()
      await reader.settle()
      expect(reader.position).toBe(intendedPosition)
      expect(reader.follow.showJumpToLatest).toBe(true)
    },
  )

  it('retains tail following through output growth and composer resizing', async () => {
    const reader = await openConversation()
    reader.append()
    reader.growContent()
    await reader.settle()
    expect(reader.atLatest).toBe(true)
    reader.resizeViewport()
    await reader.settle()
    expect(reader.atLatest).toBe(true)
  })

  it('keeps a free reader in place through output growth and composer resizing', async () => {
    const reader = await openConversation()
    reader.readEarlier()
    reader.endGesture()
    const intendedPosition = reader.position
    reader.append()
    reader.growContent()
    reader.resizeViewport()
    await reader.settle()
    expect(reader.position).toBe(intendedPosition)
    expect(reader.follow.showJumpToLatest).toBe(true)
  })

  it('does not run queued following or retain observers after disposal', async () => {
    const reader = await openConversation()
    reader.append()
    const position = reader.position
    reader.dispose()
    await reader.settle()
    expect(reader.position).toBe(position)
    expect(reader.observedTargets).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps following while the reader scrolls inside expanded details', async () => {
    const reader = await openConversation()
    reader.scrollDetails()
    reader.append()
    await reader.settle()
    expect(reader.atLatest).toBe(true)
    expect(reader.follow.showJumpToLatest).toBe(false)
  })

  it('does not let a nested scroll completion interrupt a smooth jump', async () => {
    const reader = await openConversation()
    reader.readEarlier()
    reader.endGesture()
    reader.jump()
    const start = reader.position
    reader.finishDetailsScroll()
    reader.append()
    await reader.settle()
    expect(reader.position).toBe(start)
    reader.finishSmoothJump()
    await reader.settle()
    expect(reader.atLatest).toBe(true)
  })

  it.each(['textarea', 'contenteditable', 'button-label'] as const)(
    'keeps following when navigation keys belong to a %s control',
    async (control) => {
      const reader = await openConversation()
      reader.useControl(control)
      reader.append()
      await reader.settle()
      expect(reader.atLatest).toBe(true)
    },
  )

  it('keeps following when a wheel gesture is browser zoom', async () => {
    const reader = await openConversation()
    reader.zoom()
    reader.append()
    await reader.settle()
    expect(reader.atLatest).toBe(true)
  })

  it('lets a wheel at the details boundary scroll the conversation', async () => {
    const reader = await openConversation()
    reader.scrollDetails(true)
    reader.moveEarlier()
    reader.deliverScroll()
    reader.append()
    reader.endGesture()
    await reader.settle()
    expect(reader.atLatest).toBe(false)
    expect(reader.follow.showJumpToLatest).toBe(true)
  })

  it('resumes tail following after output arrives while the panel is hidden', async () => {
    const reader = await openConversation()
    reader.hide()
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    reader.append()
    await reader.settle()
    reader.show()
    await reader.settle()
    expect(reader.atLatest).toBe(true)
    expect(reader.follow.showJumpToLatest).toBe(false)
  })

  it('restores free reading after hidden layout reports a clamped scroll', async () => {
    const reader = await openConversation()
    reader.readEarlier()
    reader.endGesture()
    const position = reader.position
    reader.hide()
    reader.append()
    reader.show()
    await reader.settle()
    expect(reader.position).toBe(position)
    expect(reader.follow.showJumpToLatest).toBe(true)
  })

  it('keeps nested overscroll containment from detaching conversation following', async () => {
    const reader = await openConversation()
    reader.scrollDetails(true, true)
    reader.append()
    await reader.settle()
    expect(reader.atLatest).toBe(true)
  })

  it('lets navigation keys scroll expanded details without pausing conversation following', async () => {
    const reader = await openConversation()
    reader.navigateDetails()
    reader.append()
    await reader.settle()
    expect(reader.atLatest).toBe(true)
  })

  it('preserves a pending history anchor when an inner scroll completes', async () => {
    const reader = await openConversation()
    reader.readEarlier()
    reader.endGesture()
    const anchor = reader.follow.captureScrollAnchor()!
    reader.finishDetailsScroll()
    expect(reader.follow.isScrollAnchorCurrent(anchor)).toBe(true)
  })

  it('does not pause following for a shortcut that leaves the conversation in place', async () => {
    const reader = await openConversation()
    reader.shortcut()
    reader.append()
    await reader.settle()
    expect(reader.atLatest).toBe(true)
  })

  it('keeps following when a pointer action belongs to a detail control', async () => {
    const reader = await openConversation()
    reader.pressControl()
    reader.append()
    await reader.settle()
    expect(reader.atLatest).toBe(true)
  })

  it('retains history scroll ownership when another restoration makes no movement', async () => {
    const reader = await openConversation()
    reader.readEarlier()
    reader.endGesture()
    const initial = reader.follow.captureScrollAnchor()!
    reader.growContent()
    act(() => expect(reader.follow.restoreScrollAnchor(initial)).toBe(true))
    const restored = reader.follow.captureScrollAnchor()!
    act(() => expect(reader.follow.restoreScrollAnchor(restored)).toBe(true))
    reader.deliverScroll()
    expect(reader.follow.isScrollAnchorCurrent(restored)).toBe(true)
  })

  it('flushes deferred layout once when the conversation gesture ends, independently of inner scrolling', async () => {
    const reader = await openConversation()
    reader.readEarlier()
    reader.finishDetailsScroll()
    expect(reader.follow.isUserScrollActive()).toBe(true)
    expect(reader.idleNotifications).toBe(0)
    reader.endGesture()
    expect(reader.follow.isUserScrollActive()).toBe(false)
    expect(reader.idleNotifications).toBe(1)
    reader.advanceIdle()
    expect(reader.idleNotifications).toBe(1)
  })

  it('reconciles deferred layout when the browser supplies no scroll completion event', async () => {
    const reader = await openConversation()
    reader.readEarlier()
    reader.advanceIdle()
    expect(reader.follow.isUserScrollActive()).toBe(false)
    expect(reader.idleNotifications).toBe(1)
    reader.endGesture()
    expect(reader.idleNotifications).toBe(1)
  })

  it('discards deferred gesture reconciliation when its surface is disposed', async () => {
    const reader = await openConversation()
    reader.readEarlier()
    reader.dispose()
    reader.advanceIdle()
    expect(reader.idleNotifications).toBe(0)
  })
})

interface ConversationScenario {
  readonly follow: ScrollFollowResult
  readonly position: number
  readonly atLatest: boolean
  readonly observedTargets: number
  readonly idleNotifications: number
  beginGesture(kind: 'wheel' | 'scrollbar' | 'keyboard'): void
  moveEarlier(): void
  settle(): Promise<void>
  deliverScroll(): void
  readEarlier(): void
  endGesture(): void
  jump(): void
  finishSmoothJump(): void
  append(): void
  switchSession(): void
  growContent(): void
  measureEarlierGrowth(): void
  resizeViewport(): void
  reconcileLayout(): void
  withTemporaryCanvas(canvas: 'shorter' | 'empty', action: () => void): void
  dispose(): void
  scrollDetails(atBoundary?: boolean, contain?: boolean): void
  finishDetailsScroll(): void
  useControl(control: 'textarea' | 'contenteditable' | 'button-label'): void
  zoom(): void
  hide(): void
  show(): void
  navigateDetails(): void
  shortcut(): void
  pressControl(): void
  advanceIdle(): void
}

/** A browser-geometry adapter; scenarios assert reader intent, independent of product markup. */
async function conversation(
  layoutMeasurementsActive: boolean,
  initiallyFits = false,
): Promise<ConversationScenario> {
  vi.useFakeTimers()
  let viewport: HTMLDivElement
  let content: HTMLDivElement
  let follow: ScrollFollowResult
  let session = 0
  let revision = 0
  let position = 0
  let contentHeight = initiallyFits ? 240 : 2_400
  let viewportHeight = 480
  let smoothDestination = 0
  let visible = true
  let details: HTMLDivElement
  let editor: HTMLTextAreaElement
  let richEditor: HTMLDivElement
  let buttonLabel: HTMLSpanElement
  let detailsPosition = 100
  let idleNotifications = 0
  const observations = new Map<Element, ResizeObserverCallback>()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly targets = new Set<Element>()
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        observations.set(target, this.callback)
        this.targets.add(target)
      }
      disconnect(): void {
        for (const target of this.targets) observations.delete(target)
      }
    },
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))

  const attachViewport = (element: HTMLDivElement | null): void => {
    follow.scrollRef.current = element
    if (element === null) return
    viewport = element
    Object.defineProperties(element, {
      scrollTop: {
        configurable: true,
        get: () => position,
        set: (next: number) => {
          position = Math.max(0, Math.min(contentHeight - viewportHeight, next))
        },
      },
      scrollHeight: { configurable: true, get: () => (visible ? contentHeight : 0) },
      clientHeight: { configurable: true, get: () => (visible ? viewportHeight : 0) },
    })
    element.scrollTo = (options: ScrollToOptions | number = {}) => {
      if (typeof options === 'number') return
      if (options.behavior === 'smooth') smoothDestination = options.top ?? position
      else element.scrollTop = options.top ?? position
    }
  }
  const attachContent = (element: HTMLDivElement | null): void => {
    follow.contentRef.current = element
    if (element !== null) content = element
  }
  const attachDetails = (element: HTMLDivElement | null): void => {
    if (element === null) return
    details = element
    Object.defineProperties(element, {
      scrollTop: { configurable: true, get: () => detailsPosition },
      scrollHeight: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 200 },
    })
  }
  function Surface(): ReactElement {
    follow = useScrollFollow({
      contentKey: revision,
      itemCount: 10,
      sessionId: String(session),
      layoutMeasurementsActive,
      onScrollIdle: () => {
        idleNotifications += 1
      },
    })
    return (
      <div key={session} ref={attachViewport}>
        <div ref={attachContent}>
          <div ref={attachDetails} style={{ overflowY: 'auto' }} />
          <textarea
            ref={(element) => {
              if (element !== null) editor = element
            }}
          />
          <div
            contentEditable
            suppressContentEditableWarning
            ref={(element) => {
              if (element !== null) richEditor = element
            }}
          />
          <button type="button">
            <span
              ref={(element) => {
                if (element !== null) buttonLabel = element
              }}
            >
              Details
            </span>
          </button>
        </div>
      </div>
    )
  }
  const view = render(<Surface />)
  const notify = (target: Element, height: number, width = 640): void => {
    observations.get(target)?.(
      [{ target, contentRect: { width, height } } as ResizeObserverEntry],
      {} as ResizeObserver,
    )
  }
  const settle = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve()
    })
  }
  const beginGesture = (kind: 'wheel' | 'scrollbar' | 'keyboard'): void => {
    if (kind === 'wheel') fireEvent.wheel(viewport, { deltaY: -1 })
    else if (kind === 'scrollbar') fireEvent.pointerDown(viewport, { button: 0 })
    else fireEvent.keyDown(viewport, { key: 'PageUp' })
  }
  const moveEarlier = (): void => {
    viewport.scrollTop = position - viewportHeight / 2
  }
  act(() => {
    notify(viewport!, viewportHeight)
    notify(content!, contentHeight)
  })
  await settle()
  return {
    get follow() {
      return follow
    },
    get position() {
      return position
    },
    get atLatest() {
      return Math.abs(Math.max(0, contentHeight - viewportHeight) - position) < 1
    },
    get observedTargets() {
      return observations.size
    },
    get idleNotifications() {
      return idleNotifications
    },
    beginGesture,
    moveEarlier,
    settle,
    deliverScroll() {
      fireEvent.scroll(viewport)
    },
    readEarlier() {
      beginGesture('wheel')
      moveEarlier()
      fireEvent.scroll(viewport)
    },
    endGesture() {
      fireEvent(viewport, new Event('scrollend'))
    },
    jump() {
      act(() => follow.userScrollToLatest())
    },
    finishSmoothJump() {
      viewport.scrollTop = smoothDestination
      fireEvent.scroll(viewport)
      fireEvent(viewport, new Event('scrollend'))
    },
    append() {
      contentHeight += viewportHeight / 3
      revision += 1
      view.rerender(<Surface />)
    },
    switchSession() {
      session += 1
      view.rerender(<Surface />)
    },
    growContent() {
      contentHeight += viewportHeight / 2
      act(() => notify(content, contentHeight))
    },
    measureEarlierGrowth() {
      const growth = viewportHeight / 4
      contentHeight += growth
      act(() => follow.applyScrollAdjustment(growth))
    },
    resizeViewport() {
      viewportHeight *= 0.8
      act(() => notify(viewport, viewportHeight))
    },
    reconcileLayout() {
      act(() => follow.scheduleScrollToLatest({ preserveBottom: true, immediate: true }))
    },
    withTemporaryCanvas(canvas, action) {
      const originalHeight = contentHeight
      contentHeight = viewportHeight + (canvas === 'empty' ? 0 : position / 2)
      viewport.scrollTop = position
      action()
      contentHeight = originalHeight
    },
    dispose() {
      view.unmount()
    },
    scrollDetails(atBoundary = false, contain = false) {
      detailsPosition = atBoundary ? 0 : 100
      details.style.overscrollBehaviorY = contain ? 'contain' : 'auto'
      fireEvent.wheel(details, { deltaY: -1 })
      fireEvent.scroll(details)
    },
    finishDetailsScroll() {
      fireEvent.scroll(details)
      fireEvent(details, new Event('scrollend'))
    },
    useControl(control) {
      const target =
        control === 'textarea' ? editor : control === 'contenteditable' ? richEditor : buttonLabel
      fireEvent.keyDown(target, { key: ' ' })
    },
    zoom() {
      fireEvent.wheel(viewport, { deltaY: -1, ctrlKey: true })
    },
    hide() {
      visible = false
      position = 0
      act(() => {
        notify(viewport, 0, 0)
        notify(content, 0, 0)
      })
      fireEvent.scroll(viewport)
    },
    show() {
      visible = true
      act(() => {
        notify(viewport, viewportHeight)
        notify(content, contentHeight)
      })
      fireEvent.scroll(viewport)
    },
    navigateDetails() {
      fireEvent.keyDown(details, { key: 'PageUp' })
    },
    shortcut() {
      fireEvent.keyDown(viewport, { key: 'Home', ctrlKey: true })
    },
    pressControl() {
      fireEvent.pointerDown(buttonLabel, { button: 0 })
    },
    advanceIdle() {
      act(() => {
        vi.advanceTimersByTime(1_000)
      })
    },
  }
}
