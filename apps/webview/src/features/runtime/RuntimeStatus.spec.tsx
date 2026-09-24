// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeStatus } from './RuntimeStatus.js'

describe('RuntimeStatus', () => {
  afterEach(() => cleanup())

  it('exposes failure details and recovery actions without squeezing the header', () => {
    const message = 'transport failure for /api/events.mux: HTTP 426'
    const onRetry = vi.fn()
    const onOpenSettings = vi.fn()
    render(
      <RuntimeStatus
        state={{ kind: 'failed', message, retryable: true }}
        onRetry={onRetry}
        onOpenSettings={onOpenSettings}
      />,
    )

    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Connection failed')
    const trigger = screen.getByRole('button', { name: 'Connection failed' })
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Connection details' })).toBeDefined()
    expect(screen.getByText(message)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Connection settings' }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('exposes connected state as a compact live status with inspectable facts', () => {
    render(<RuntimeStatus state={{ kind: 'connected' }} connectedDshVersion="0.1.0-rc.6" />)

    expect(screen.getByRole('status').textContent).toBe('Connected')
    expect(screen.getByRole('button', { name: 'Connected' })).toBeDefined()
    expect(screen.getByRole('status').querySelector('.dsh-runtime-status__icon')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Connected' }))
    expect(screen.getByText('0.1.0-rc.6')).toBeDefined()
  })

  it('keeps connection details user focused without exposing the adapter capability matrix', () => {
    render(
      <RuntimeStatus
        state={{ kind: 'connected' }}
        connectedDshVersion="0.1.7-rc.1"
        onOpenSettings={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Connected' }))

    const dialog = within(screen.getByRole('dialog', { name: 'Connection details' }))
    expect(dialog.getByText('DSH version')).toBeDefined()
    expect(dialog.getByText('0.1.7-rc.1')).toBeDefined()
    expect(dialog.getByRole('button', { name: 'Connection settings' })).toBeDefined()
    expect(dialog.queryByText('Capability profile')).toBeNull()
    expect(dialog.queryByText('ED-01')).toBeNull()
    expect(dialog.queryByText('Fallback')).toBeNull()
  })

  it('names the panel close control after the panel it closes', () => {
    render(<RuntimeStatus state={{ kind: 'connected' }} connectedDshVersion="0.1.0-rc.6" />)

    fireEvent.click(screen.getByRole('button', { name: 'Connected' }))

    expect(screen.getByRole('button', { name: 'Close connection details' })).toBeDefined()
    // The real settings drawer owns "Close settings"; this popover must not
    // announce itself as that control.
    expect(screen.queryByRole('button', { name: 'Close settings' })).toBeNull()
  })
})
