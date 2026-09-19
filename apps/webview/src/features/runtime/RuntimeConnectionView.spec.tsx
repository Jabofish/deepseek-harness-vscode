// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeConnectionView } from './RuntimeConnectionView.js'

describe('RuntimeConnectionView', () => {
  afterEach(() => cleanup())

  it.each([
    ['idle', 'Preparing DSH connection'],
    ['discovering', 'Finding DSH'],
    ['locating-runtime', 'Locating DSH runtime'],
    ['starting', 'Opening DSH'],
    ['connecting', 'Connecting to DSH'],
  ] as const)('renders the live connection stage for %s', (kind, title) => {
    render(<RuntimeConnectionView state={{ kind }} />)

    expect(screen.getByRole('heading', { name: title })).toBeDefined()
    expect(screen.getByRole('heading').closest('section')?.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByLabelText('DSH connection progress')).toBeDefined()
  })

  it('keeps the connected catalog-loading state distinct from an empty session', () => {
    render(<RuntimeConnectionView state={{ kind: 'connected' }} loadingSessionCatalog />)

    expect(screen.getByRole('heading', { name: 'Loading sessions' })).toBeDefined()
    expect(
      screen.getByText('DSH is connected. The extension is loading workspaces and sessions.'),
    ).toBeDefined()
    expect(screen.getByRole('heading').closest('section')?.getAttribute('aria-busy')).toBe('true')
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('Load sessions')
  })

  it('shows the host failure and recovery actions', () => {
    const onRetry = vi.fn()
    const onOpenSettings = vi.fn()
    render(
      <RuntimeConnectionView
        state={{ kind: 'failed', message: 'DSH did not respond.', retryable: true }}
        onRetry={onRetry}
        onOpenSettings={onOpenSettings}
      />,
    )

    expect(screen.getByRole('heading', { name: 'DSH connection failed' })).toBeDefined()
    expect(screen.getByText('DSH did not respond.')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Connection settings' }))
    expect(onRetry).toHaveBeenCalledOnce()
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })
})
