// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useRef, type ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { useViewportMenuPosition } from './useViewportMenuPosition.js'

describe('useViewportMenuPosition', () => {
  afterEach(() => cleanup())

  it('marks a menu that opens above and toward the viewport edge for the shared origin rules', async () => {
    render(<MenuHarness />)

    const menu = screen.getByRole('menu')
    await waitFor(() => {
      expect(menu.dataset.flipX).toBe('true')
      expect(menu.dataset.flipY).toBe('true')
    })
    expect(menu.style.top).toBe('532px')
    expect(menu.style.left).toBe('680px')
    expect(menu.style.width).toBe('300px')
  })
})

function MenuHarness(): ReactElement {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const position = useViewportMenuPosition({
    open: true,
    anchorRef,
    menuRef,
    placement: 'above',
    align: 'end',
    gap: 8,
    margin: 8,
  })

  return (
    <>
      <button
        ref={(node) => {
          anchorRef.current = node
          if (node !== null) node.getBoundingClientRect = () => rect(900, 700, 80, 20)
        }}
        type="button"
      >
        Anchor
      </button>
      <div
        ref={(node) => {
          menuRef.current = node
          if (node !== null) node.getBoundingClientRect = () => rect(0, 0, 300, 160)
        }}
        role="menu"
        style={position}
      />
    </>
  )
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  }
}
