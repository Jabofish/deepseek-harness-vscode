// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRowActions } from './session-row-actions.js'

function renderActions(
  overrides: Partial<Parameters<typeof SessionRowActions>[0]> = {},
): ReturnType<typeof render> {
  const props = {
    title: 'Fix login bug',
    disabled: false,
    onRename: vi.fn(),
    ...overrides,
  }
  return render(<SessionRowActions {...props} />)
}

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: 'Session actions for Fix login bug' })
}

function menu(): HTMLElement | null {
  return screen.queryByRole('dialog', { name: 'Session actions for Fix login bug' })
}

describe('session row actions', () => {
  afterEach(() => cleanup())

  it('keeps one closed trigger in the row instead of a visible action rail', () => {
    renderActions({ onOpenInEditor: vi.fn(), onArchive: vi.fn() })

    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(trigger().getAttribute('title')).toBe('Session actions')
    expect(trigger().getAttribute('aria-controls')).toBeNull()
    expect(menu()).toBeNull()
  })

  it('opens the menu in row order and takes focus into it', () => {
    renderActions({ onOpenInEditor: vi.fn(), onArchive: vi.fn() })

    fireEvent.click(trigger())

    const panel = menu()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(trigger().getAttribute('aria-controls')).toBe(panel?.id)
    expect(
      within(panel!)
        .getAllByRole('button')
        .map((item) => item.textContent),
    ).toEqual(['Open in Editor Area', 'Rename session', 'Archive session'])
    expect(within(panel!).getByRole('button', { name: 'Open in Editor Area' })).toBe(document.activeElement)
  })

  it('waits for the visible positioning pass before moving focus into the menu', () => {
    // The positioned surface is hidden until the hook has measured it, and
    // Chromium refuses to focus a hidden element. jsdom would accept that
    // attempt, so this case rejects focus calls made against a hidden panel and
    // proves the first open still lands on its first entry.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const nativeFocus = HTMLElement.prototype.focus
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    const focusedWhileHidden: string[] = []
    focus.mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      if (this.closest<HTMLElement>('.dsh-session-item__menu-panel')?.style.visibility === 'hidden') {
        focusedWhileHidden.push(this.textContent ?? '')
        return
      }
      nativeFocus.call(this, options)
    })
    try {
      renderActions()

      fireEvent.click(trigger())

      expect(screen.getByRole('button', { name: 'Rename session' })).toBe(document.activeElement)
      expect(focusedWhileHidden).toEqual([])
    } finally {
      focus.mockRestore()
    }
  })

  it('survives a press inside its own menu and reports exactly one action', () => {
    const onArchive = vi.fn()
    const onOpenInEditor = vi.fn()
    renderActions({ onOpenInEditor, onArchive })

    fireEvent.click(trigger())
    const archive = screen.getByRole('button', { name: 'Archive session' })
    // A real press is pointerdown then click; the layer must treat the menu's
    // own portalled surface as inside, or the press would dismiss the menu
    // before the action it targets ever runs.
    fireEvent.pointerDown(archive)
    expect(menu()).not.toBeNull()

    fireEvent.click(archive)

    expect(onArchive).toHaveBeenCalledExactlyOnceWith()
    expect(onOpenInEditor).not.toHaveBeenCalled()
    expect(menu()).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('hands the rename dialog the trigger that must regain focus', () => {
    const onRename = vi.fn()
    renderActions({ onRename })

    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }))

    expect(onRename).toHaveBeenCalledExactlyOnceWith(trigger())
  })

  it('offers only the actions the row actually owns', () => {
    renderActions()

    fireEvent.click(trigger())

    expect(screen.queryByRole('button', { name: 'Open in Editor Area' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Archive session' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Rename session' })).toBeDefined()
  })

  it('gives Escape back to the trigger without leaving the menu behind', () => {
    renderActions({ onArchive: vi.fn() })

    fireEvent.click(trigger())
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('cannot be opened while a list mutation locks the row', () => {
    renderActions({ disabled: true })

    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(trigger())

    expect(menu()).toBeNull()
  })

  it('closes an open menu when a mutation locks the row', () => {
    const view = renderActions({ onArchive: vi.fn() })
    fireEvent.click(trigger())
    expect(menu()).not.toBeNull()

    view.rerender(<SessionRowActions title="Fix login bug" disabled={true} onRename={vi.fn()} />)

    expect(menu()).toBeNull()
  })
})
