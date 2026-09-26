// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef, type ReactElement, type ReactNode } from 'react'
import { useDismissibleLayer } from './useDismissibleLayer.js'

afterEach(() => cleanup())

interface LayerProps {
  readonly open: boolean
  readonly label: string
  readonly trapFocus?: boolean
  readonly onTab?: (event: KeyboardEvent) => void
  readonly children: ReactNode
}

function Layer({ open, label, trapFocus = false, onTab, children }: LayerProps): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null)
  useDismissibleLayer({
    open,
    refs: [ref],
    onDismiss: () => undefined,
    trapFocus,
    ...(onTab === undefined ? {} : { onTab }),
  })
  if (!open) return null
  return createPortal(
    <div ref={ref} role={trapFocus ? 'dialog' : 'region'} aria-label={label} tabIndex={-1}>
      {children}
    </div>,
    document.body,
  )
}

function NestedLayers({
  childOpen,
  innerModalOpen,
  onChildTab,
}: {
  readonly childOpen: boolean
  readonly innerModalOpen: boolean
  readonly onChildTab?: (event: KeyboardEvent) => void
}): ReactElement {
  return (
    <>
      <button type="button">Outside before</button>
      <Layer open label="Outer dialog" trapFocus>
        <button type="button">Outer first</button>
        <button type="button">Outer last</button>
      </Layer>
      <Layer
        open={childOpen}
        label="Dialog child menu"
        {...(onChildTab === undefined ? {} : { onTab: onChildTab })}
      >
        <button type="button">Child menu item</button>
      </Layer>
      <Layer open={innerModalOpen} label="Inner dialog" trapFocus>
        <button type="button">Inner only</button>
      </Layer>
      <button type="button">Outside after</button>
    </>
  )
}

describe('useDismissibleLayer focus trap', () => {
  it('cycles through a portal child owned by the modal without reaching the page', () => {
    const onChildTab = vi.fn((event: KeyboardEvent) => {
      expect(event.defaultPrevented).toBe(false)
    })
    const view = render(<NestedLayers childOpen={false} innerModalOpen={false} onChildTab={onChildTab} />)
    view.rerender(<NestedLayers childOpen innerModalOpen={false} onChildTab={onChildTab} />)

    const first = screen.getByRole('button', { name: 'Outer first' })
    const last = screen.getByRole('button', { name: 'Outer last' })
    const child = screen.getByRole('button', { name: 'Child menu item' })
    const outerDialog = screen.getByRole('dialog', { name: 'Outer dialog' })
    const childLayer = screen.getByRole('region', { name: 'Dialog child menu' })

    expect(view.container.hasAttribute('inert')).toBe(true)
    expect(outerDialog.hasAttribute('inert')).toBe(false)
    expect(childLayer.hasAttribute('inert')).toBe(false)

    first.focus()
    expect(fireEvent.keyDown(first, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(last)
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(child)
    expect(onChildTab).toHaveBeenCalledTimes(2)
    expect(fireEvent.keyDown(child, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(first)
    expect(fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(child)
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Outside after' }))
  })

  it('lets the top portal handle Tab before the modal enforces its focus boundary', () => {
    const onChildTab = vi.fn((event: KeyboardEvent) => {
      event.preventDefault()
      screen.getByRole('button', { name: 'Child menu item' }).focus()
    })
    const view = render(<NestedLayers childOpen={false} innerModalOpen={false} onChildTab={onChildTab} />)
    view.rerender(<NestedLayers childOpen innerModalOpen={false} onChildTab={onChildTab} />)

    const first = screen.getByRole('button', { name: 'Outer first' })
    const child = screen.getByRole('button', { name: 'Child menu item' })
    first.focus()
    fireEvent.keyDown(first, { key: 'Tab' })

    expect(onChildTab).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(child)
  })

  it('keeps a child layer callback from moving focus outside its modal scope', () => {
    const onChildTab = vi.fn((event: KeyboardEvent) => {
      event.preventDefault()
      screen.getByRole('button', { name: 'Outside after' }).focus()
    })
    const view = render(<NestedLayers childOpen={false} innerModalOpen={false} onChildTab={onChildTab} />)
    view.rerender(<NestedLayers childOpen innerModalOpen={false} onChildTab={onChildTab} />)

    const first = screen.getByRole('button', { name: 'Outer first' })
    first.focus()
    fireEvent.keyDown(first, { key: 'Tab' })

    expect(document.activeElement).toBe(first)
    expect(onChildTab).toHaveBeenCalledOnce()
  })

  it('lets a newer modal own focus and restores the previous trap when it closes', () => {
    const view = render(<NestedLayers childOpen={false} innerModalOpen={false} />)
    view.rerender(<NestedLayers childOpen={false} innerModalOpen />)

    const inner = screen.getByRole('button', { name: 'Inner only' })
    const outerDialog = screen.getByRole('dialog', { name: 'Outer dialog' })
    const innerDialog = screen.getByRole('dialog', { name: 'Inner dialog' })
    expect(view.container.hasAttribute('inert')).toBe(true)
    expect(outerDialog.hasAttribute('inert')).toBe(true)
    expect(innerDialog.hasAttribute('inert')).toBe(false)
    inner.focus()
    expect(fireEvent.keyDown(inner, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(inner)

    view.rerender(<NestedLayers childOpen={false} innerModalOpen={false} />)
    expect(outerDialog.hasAttribute('inert')).toBe(false)
    expect(view.container.hasAttribute('inert')).toBe(true)
    const outerFirst = screen.getByRole('button', { name: 'Outer first' })
    const outerLast = screen.getByRole('button', { name: 'Outer last' })
    outerLast.focus()
    expect(fireEvent.keyDown(outerLast, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(outerFirst)
  })

  it('keeps a single enabled tab stop and excludes hidden or disabled controls', () => {
    render(
      <Layer open label="Single-stop dialog" trapFocus>
        <button type="button" hidden>
          Hidden
        </button>
        <button type="button" disabled>
          Disabled
        </button>
        <button type="button" tabIndex={-1}>
          Programmatic only
        </button>
        <div aria-hidden="true">
          <button type="button">Hidden from assistive technology</button>
        </div>
        <div style={{ display: 'none' }}>
          <button type="button">Hidden by ancestor display</button>
        </div>
        <div style={{ visibility: 'hidden' }}>
          <button type="button">Hidden by ancestor visibility</button>
        </div>
        <input type="hidden" aria-label="Hidden input" />
        <button type="button">Only tab stop</button>
      </Layer>,
    )

    const only = screen.getByRole('button', { name: 'Only tab stop' })
    only.focus()
    expect(fireEvent.keyDown(only, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(only)
    expect(fireEvent.keyDown(only, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(only)
  })

  it('keeps focus on the modal root when it has no tab stops', () => {
    render(
      <>
        <button type="button">Outside</button>
        <Layer open label="Empty dialog" trapFocus>
          <p>Nothing to tab to.</p>
        </Layer>
      </>,
    )

    const dialog = screen.getByRole('dialog', { name: 'Empty dialog' })
    const outside = screen.getByRole('button', { name: 'Outside' })
    outside.focus()
    expect(fireEvent.keyDown(outside, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(dialog)
    expect(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(dialog)
  })

  it('orders explicit positive tabIndex stops before natural stops', () => {
    render(
      <>
        <button type="button">Outside</button>
        <Layer open label="Ordered dialog" trapFocus>
          <button type="button" tabIndex={3}>
            Third stop
          </button>
          <button type="button">Natural stop</button>
          <button type="button" tabIndex={1}>
            First stop
          </button>
        </Layer>
      </>,
    )

    const outside = screen.getByRole('button', { name: 'Outside' })
    outside.focus()
    fireEvent.keyDown(outside, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First stop' }))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Third stop' }))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Natural stop' }))
  })

  it('restores a background element that was already inert before the modal opened', () => {
    const preInertBackground = document.createElement('main')
    preInertBackground.setAttribute('inert', '')
    document.body.append(preInertBackground)
    try {
      const view = render(
        <Layer open label="Preserving dialog" trapFocus>
          <button type="button">Dialog action</button>
        </Layer>,
      )

      expect(preInertBackground.hasAttribute('inert')).toBe(true)
      view.rerender(
        <Layer open={false} label="Preserving dialog" trapFocus>
          <button type="button">Dialog action</button>
        </Layer>,
      )
      expect(preInertBackground.hasAttribute('inert')).toBe(true)
    } finally {
      preInertBackground.remove()
    }
  })
})
