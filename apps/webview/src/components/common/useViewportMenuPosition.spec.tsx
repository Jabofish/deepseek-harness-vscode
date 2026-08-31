// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useRef, type ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { useViewportMenuPosition } from './useViewportMenuPosition.js'

const MENU_WIDTH = 300
const MENU_HEIGHT = 160
// The pop-in entry animation starts at scale(0.97); getBoundingClientRect
// reads that transformed box while the layout size stays unchanged.
const ANIMATION_SCALE = 0.97

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
    expect(menu.style.width).toBe(`${MENU_WIDTH}px`)
  })

  it('keeps the inline width stable across reopen cycles while the entry animation is scaling', async () => {
    const { rerender } = render(<MenuHarness />)
    const menu = screen.getByRole('menu')
    await waitFor(() => expect(menu.style.width).toBe(`${MENU_WIDTH}px`))

    for (let cycle = 0; cycle < 3; cycle += 1) {
      rerender(<MenuHarness open={false} />)
      rerender(<MenuHarness open />)
      expect(menu.style.width).toBe(`${MENU_WIDTH}px`)
    }
  })
})

function MenuHarness({ open = true }: { open?: boolean }): ReactElement {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const position = useViewportMenuPosition({
    open,
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
          if (node === null) return
          Object.defineProperty(node, 'offsetWidth', { value: MENU_WIDTH, configurable: true })
          Object.defineProperty(node, 'offsetHeight', { value: MENU_HEIGHT, configurable: true })
          node.getBoundingClientRect = () =>
            rect(0, 0, MENU_WIDTH * ANIMATION_SCALE, MENU_HEIGHT * ANIMATION_SCALE)
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
