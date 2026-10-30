// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosticsSnapshot } from '@dsh-vscode/domain'
import { I18nProvider } from '../../i18n.js'
import { DiagnosticsDrawer } from './DiagnosticsDrawer.js'

const baseSnapshot: DiagnosticsSnapshot = {
  extensionVersion: '0.1.11',
  dshVersion: '0.1.9',
  state: 'failed',
  endpointKind: 'managed',
  canReconnect: true,
  recentEvents: ['{"level":"error","event":"connection-state"}'],
}

describe('DiagnosticsDrawer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    act(() => {
      vi.clearAllTimers()
    })
    vi.useRealTimers()
    cleanup()
  })

  it('loads initially and refreshes periodically while open without clearing snapshot', async () => {
    let callCount = 0
    const onRead = vi.fn().mockImplementation(() => {
      callCount++
      return Promise.resolve({
        ...baseSnapshot,
        dshVersion: callCount === 1 ? '0.1.9' : '0.2.0',
      })
    })

    render(
      <I18nProvider>
        <DiagnosticsDrawer onRead={onRead} onReconnect={vi.fn()} onShowOutput={vi.fn()} />
      </I18nProvider>,
    )

    const trigger = screen.getByRole('button', { name: /diagnostics/i })
    await act(async () => {
      fireEvent.click(trigger)
      await Promise.resolve()
    })

    expect(onRead).toHaveBeenCalledTimes(1)
    expect(screen.getByText('0.1.9')).toBeDefined()

    // Advance 5 seconds to trigger auto-refresh
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(onRead).toHaveBeenCalledTimes(2)
    expect(screen.getByText('0.2.0')).toBeDefined()

    // Close the drawer
    const closeBtn = screen.getByRole('button', { name: 'Close' })
    act(() => {
      fireEvent.click(closeBtn)
    })

    // Advance 10 more seconds while closed: timer must be cleared
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000)
    })

    expect(onRead).toHaveBeenCalledTimes(2)
  })

  it('preserves existing snapshot when background auto-refresh fails', async () => {
    let callCount = 0
    const onRead = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve(baseSnapshot)
      return Promise.reject(new Error('Network error'))
    })

    render(
      <I18nProvider>
        <DiagnosticsDrawer onRead={onRead} onReconnect={vi.fn()} onShowOutput={vi.fn()} />
      </I18nProvider>,
    )

    const trigger = screen.getByRole('button', { name: /diagnostics/i })
    await act(async () => {
      fireEvent.click(trigger)
      await Promise.resolve()
    })

    expect(screen.getByText('0.1.9')).toBeDefined()

    // Advance 5 seconds: second read fails
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    // Existing snapshot is still present and readable
    expect(screen.getByText('0.1.9')).toBeDefined()
  })

  it('keeps a failed reconnect visible when a background snapshot read succeeds', async () => {
    const onRead = vi.fn().mockResolvedValue(baseSnapshot)
    render(
      <DiagnosticsDrawer
        onRead={onRead}
        onReconnect={vi.fn().mockRejectedValue(new Error('Reconnect failed'))}
        onShowOutput={vi.fn()}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /diagnostics/i }))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
      await Promise.resolve()
    })
    expect(screen.getByRole('alert')).toBeDefined()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(onRead).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('alert')).toBeDefined()
  })

  it('keeps a slow poll single and reads fresh diagnostics after reconnecting', async () => {
    let resolvePoll!: (snapshot: DiagnosticsSnapshot) => void
    const poll = new Promise<DiagnosticsSnapshot>((resolve) => {
      resolvePoll = resolve
    })
    const onRead = vi
      .fn()
      .mockResolvedValueOnce(baseSnapshot)
      .mockReturnValueOnce(poll)
      .mockResolvedValue({ ...baseSnapshot, dshVersion: '0.2.1-rc.5' })
    const onReconnect = vi.fn().mockResolvedValue(undefined)
    render(
      <I18nProvider>
        <DiagnosticsDrawer onRead={onRead} onReconnect={onReconnect} onShowOutput={vi.fn()} />
      </I18nProvider>,
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /diagnostics/i }))
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(onRead).toHaveBeenCalledTimes(2)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
      await Promise.resolve()
    })
    expect(onReconnect).toHaveBeenCalledOnce()
    expect(onRead).toHaveBeenCalledTimes(2)
    await act(async () => {
      resolvePoll(baseSnapshot)
      await Promise.resolve()
    })
    expect(onRead).toHaveBeenCalledTimes(3)
    expect(screen.getByText('0.2.1-rc.5')).toBeDefined()
  })

  it('discards a retired reader result after closing and changing the diagnostic source', async () => {
    let resolveOld!: (snapshot: DiagnosticsSnapshot) => void
    const onOldRead = vi.fn(
      () =>
        new Promise<DiagnosticsSnapshot>((resolve) => {
          resolveOld = resolve
        }),
    )
    const onNewRead = vi.fn().mockResolvedValue({ ...baseSnapshot, dshVersion: '0.2.1-rc.5' })
    const view = render(<DiagnosticsDrawer onRead={onOldRead} onReconnect={vi.fn()} onShowOutput={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /diagnostics/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    view.rerender(<DiagnosticsDrawer onRead={onNewRead} onReconnect={vi.fn()} onShowOutput={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /diagnostics/i }))
      await Promise.resolve()
    })
    await act(async () => {
      resolveOld(baseSnapshot)
      await Promise.resolve()
    })
    expect(screen.getByText('0.2.1-rc.5')).toBeDefined()
    expect(screen.queryByText('0.1.9')).toBeNull()
  })
})
