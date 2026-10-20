// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CopyButton } from './CopyButton.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
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

  it('resolves the complete text before writing a clipped row', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const resolveText = vi.fn().mockResolvedValue('complete payload')
    render(<CopyButton text="truncated prefix" resolveText={resolveText} className="btn" />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('complete payload'))
    expect(resolveText).toHaveBeenCalledTimes(1)
  })

  it('states a refused copy instead of staying silent', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) },
    })
    const execCommand = vi.fn(() => false)
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
    render(<CopyButton text="payload" className="btn" />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

    // The DOM fallback refused too, so the write did not happen: the button
    // must say so rather than keep its idle label.
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByRole('status').textContent).toBe('Copy failed')
    expect(screen.getByRole('button', { name: 'Copy failed' })).toBeDefined()

    // The state is transient; a retry is possible afterwards.
    await act(() => vi.advanceTimersByTimeAsync(1_000))
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDefined()
  })
})
