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
  it('keeps new notices compact and exposes the primary action and dismissal', () => {
    const run = vi.fn()
    const update = { ...notice('update'), action: { label: 'Open settings', icon: 'settings' as const, run } }
    const view = render(
      <I18nProvider>
        <AppNotices notices={[update]} />
      </I18nProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(run).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss update' }))
    expect(update.onDismiss).toHaveBeenCalledOnce()
    view.rerender(
      <I18nProvider>
        <AppNotices notices={[update, notice('connection')]} />
      </I18nProvider>,
    )
    expect(screen.getByRole('button', { name: 'Show notifications (2)' }).getAttribute('aria-expanded')).toBe(
      'false',
    )
    expect(document.querySelector('.dsh-app__notice-list')).toBeNull()
    expect(screen.queryByText('Full details for connection')).toBeNull()
  })

  it('reveals complete messages on request and collapses with Escape without trapping focus', () => {
    const error = { ...notice('error'), tone: 'danger' as const, message: 'Long details '.repeat(100) }
    render(
      <I18nProvider>
        <AppNotices notices={[error, notice('update')]} />
      </I18nProvider>,
    )
    expect(screen.getByRole('alert').textContent).toContain(error.title)
    fireEvent.click(screen.getByRole('button', { name: 'Show notifications (2)' }))
    expect(document.querySelector('.dsh-app__notice-list')?.textContent).toContain(error.message)
    const dismiss = screen.getByRole('button', { name: 'Dismiss error' })
    dismiss.focus()
    fireEvent.keyDown(dismiss, { key: 'Escape' })
    const toggle = screen.getByRole('button', { name: 'Show notifications (2)' })
    expect(document.activeElement).toBe(toggle)
    expect(document.querySelector('.dsh-app__notice-list')).toBeNull()
    fireEvent.click(toggle)
    fireEvent.keyDown(toggle, { key: 'Escape' })
    expect(document.querySelector('.dsh-app__notice-list')).toBeNull()
  })

  it('keeps keyboard focus on the notification control when a detail entry is dismissed', () => {
    const first = notice('first')
    const second = notice('second')
    const view = render(
      <I18nProvider>
        <AppNotices notices={[first, second]} />
      </I18nProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show notifications (2)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss first' }))
    expect(first.onDismiss).toHaveBeenCalledOnce()
    view.rerender(
      <I18nProvider>
        <AppNotices notices={[second]} />
      </I18nProvider>,
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Collapse notifications (1)' }))
    expect(screen.getByRole('button', { name: 'Dismiss second' })).toBeDefined()
  })
})
