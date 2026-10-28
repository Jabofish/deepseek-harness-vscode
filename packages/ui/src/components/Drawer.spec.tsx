// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Drawer } from './Drawer.js'

describe('Drawer', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
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
