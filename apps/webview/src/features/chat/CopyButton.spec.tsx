// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CopyButton } from './CopyButton.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('CopyButton', () => {
  it('announces a completed copy to assistive tech', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    render(<CopyButton text="payload" className="btn" />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied'))
    expect(screen.getByRole('button', { name: 'Copied' })).toBeDefined()
  })

  it('states a refused copy instead of staying silent', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) },
    })
    const execCommand = vi.fn(() => false)
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
    render(<CopyButton text="payload" className="btn" />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

    // The DOM fallback refused too, so the write did not happen: the button
    // must say so rather than keep its idle label.
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copy failed'))
    expect(screen.getByRole('button', { name: 'Copy failed' })).toBeDefined()

    // The state is transient; a retry is possible afterwards.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy' })).toBeDefined(), {
      timeout: 2_000,
    })
  })
})
