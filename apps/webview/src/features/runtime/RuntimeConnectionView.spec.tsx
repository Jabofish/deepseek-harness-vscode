// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionLogEntry } from '@dsh-vscode/domain'
import { RuntimeConnectionView } from './RuntimeConnectionView.js'

const first: ConnectionLogEntry = {
  id: 1,
  time: '2026-10-18T05:00:00.000Z',
  elapsedMs: 0,
  phase: 'connect',
  status: 'started',
  mode: 'auto',
}
const found: ConnectionLogEntry = {
  id: 2,
  time: '2026-10-18T05:00:00.230Z',
  elapsedMs: 230,
  phase: 'discovery',
  status: 'succeeded',
  count: 2,
}

describe('RuntimeConnectionView', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('preserves connection output on failure, exposes recovery and stops animation', () => {
    const retry = vi.fn()
    render(
      <RuntimeConnectionView
        state={{ kind: 'failed', message: 'DSH did not respond.', retryable: true }}
        output={[first, found]}
        onRetry={retry}
      />,
    )
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('DSH did not respond.')
    expect(screen.getByRole('log').textContent).toContain('2 candidates')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('distinguishes session catalog loading from readiness and reports an Output action failure', async () => {
    const { rerender } = render(
      <RuntimeConnectionView
        state={{ kind: 'connected' }}
        output={[found]}
        loadingSessionCatalog
        onShowDiagnosticsOutput={() => Promise.reject(new Error('private'))}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Loading sessions' })).toBeDefined()
    expect(screen.getByRole('log').textContent).toContain('Loading workspaces and sessions')
    fireEvent.click(screen.getByRole('button', { name: 'Open Output' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Unable to open Output.'))
    expect(document.body.textContent).not.toContain('private')
    rerender(<RuntimeConnectionView state={{ kind: 'connected' }} output={[found]} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByRole('heading', { name: 'DSH is ready' })).toBeDefined()
  })
})
