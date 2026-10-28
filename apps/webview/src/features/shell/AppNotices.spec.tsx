// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../i18n.js'
import { AppNotices, type AppNotice } from './AppNotices.js'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

function notice(id: string): AppNotice {
  return {
    id,
    tone: 'warning',
    title: `Notice ${id}`,
    message: `Full details for ${id}`,
    dismissLabel: `Dismiss ${id}`,
    onDismiss: vi.fn(),
  }
}

describe('Nonblocking app notices', () => {
  it('reveals complete messages on request and collapses with Escape without trapping focus', () => {
    const error = { ...notice('error'), tone: 'danger' as const, message: 'Long details '.repeat(100) }
    render(
      <I18nProvider>
        <AppNotices notices={[error, notice('update')]} />
      </I18nProvider>,
    )
    expect(screen.getByRole('alert').textContent).toContain(error.title)
    fireEvent.click(screen.getByRole('button', { name: 'Show notifications (2)' }))
    expect(document.body.textContent).toContain(error.message)
    const dismiss = screen.getByRole('button', { name: 'Dismiss error' })
    dismiss.focus()
    fireEvent.keyDown(dismiss, { key: 'Escape' })
    const toggle = screen.getByRole('button', { name: 'Show notifications (2)' })
    expect(document.activeElement).toBe(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    fireEvent.keyDown(toggle, { key: 'Escape' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })
})
