// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Drawer } from './Drawer.js'

describe('Drawer', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('does not mount a closed drawer and closes from Escape while open', () => {
    const onClose = vi.fn()
    const view = render(<Drawer title="Settings" open={false} onClose={onClose} />)
    expect(screen.queryByRole('dialog')).toBeNull()

    view.rerender(<Drawer title="Settings" open onClose={onClose} />)
    expect(screen.getByRole('dialog').parentElement?.getAttribute('data-state')).toBe('open')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    view.rerender(<Drawer title="Settings" open={false} onClose={onClose} />)
    expect(screen.getByRole('dialog').parentElement?.getAttribute('data-state')).toBe('closing')
  })

  it('keeps the surface mounted while an exit animation is finishing', () => {
    const onClose = vi.fn()
    const view = render(
      <Drawer title="Settings" open onClose={onClose}>
        <button type="button">Focusable content</button>
      </Drawer>,
    )

    const dialog = screen.getByRole('dialog')
    const backdrop = dialog.parentElement
    expect(backdrop?.getAttribute('data-state')).toBe('open')

    view.rerender(
      <Drawer title="Settings" open={false} onClose={onClose}>
        <button type="button">Focusable content</button>
      </Drawer>,
    )

    expect(screen.getByRole('dialog').getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('dialog').parentElement?.getAttribute('data-state')).toBe('closing')
    fireEvent.animationEnd(screen.getByRole('dialog'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('uses the unload fallback when the browser omits animationend', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const view = render(<Drawer title="Settings" open onClose={onClose} />)

    view.rerender(<Drawer title="Settings" open={false} onClose={onClose} />)
    expect(screen.getByRole('dialog')).toBeDefined()

    vi.advanceTimersByTime(361)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('restores focus when closing starts and ignores backdrop input during exit', () => {
    const onClose = vi.fn()
    const view = render(
      <>
        <button type="button">Open settings</button>
        <Drawer title="Settings" open onClose={onClose} />
      </>,
    )
    const trigger = screen.getByRole('button', { name: 'Open settings' })
    trigger.focus()

    const dialog = screen.getByRole('dialog')
    view.rerender(
      <>
        <button type="button">Open settings</button>
        <Drawer title="Settings" open={false} onClose={onClose} />
      </>,
    )
    const closingBackdrop = screen.getByRole('presentation')
    fireEvent.mouseDown(closingBackdrop)

    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
    expect(dialog.getAttribute('aria-hidden')).toBe('true')
  })
})
