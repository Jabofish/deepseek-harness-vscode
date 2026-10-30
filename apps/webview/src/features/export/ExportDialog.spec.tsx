// @vitest-environment jsdom

import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { I18nProvider } from '../../i18n.js'
import { ExportDialog } from './ExportDialog.js'

const STORAGE_KEY = 'dsh-export-format'

function renderDialog(onExport = vi.fn(), onClose = vi.fn()): ReturnType<typeof render> {
  return render(
    <I18nProvider>
      <ExportDialog sessionId="session-1" onExport={onExport} onClose={onClose} />
    </I18nProvider>,
  )
}

describe('ExportDialog', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    window.localStorage.clear()
    cleanup()
  })

  it('defaults to markdown when no previous format is stored', () => {
    renderDialog()
    expect(screen.getByRole('button', { name: /Markdown/i })).toBeTruthy()
  })

  it('restores the previously saved format from localStorage', () => {
    window.localStorage.setItem(STORAGE_KEY, 'json')
    renderDialog()
    expect(screen.getByRole('button', { name: /JSON/i })).toBeTruthy()
  })

  it('ignores an invalid stored format', () => {
    window.localStorage.setItem(STORAGE_KEY, 'pdf')
    renderDialog()
    expect(screen.getByRole('button', { name: /Markdown/i })).toBeTruthy()
  })

  it('persists the chosen format on submit', () => {
    const onExport = vi.fn()
    renderDialog(onExport)

    const formatButton = screen.getByRole('button', { name: /^Format:/iu })
    fireEvent.click(formatButton)
    const jsonOption = screen.getByRole('option', { name: /JSON/i })
    fireEvent.click(jsonOption)

    const submit = screen.getByRole('button', { name: /Export/i })
    fireEvent.click(submit)

    expect(onExport).toHaveBeenCalledWith(expect.objectContaining({ format: 'json' }))
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('json')
  })
})
