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
  it('previews four recent entries and expands the complete log on demand', () => {
    const output = [
      first,
      ...Array.from({ length: 7 }, (_, index) => ({ ...found, id: index + 2, count: index + 1 })),
    ]
    const { rerender } = render(<RuntimeConnectionView state={{ kind: 'starting' }} output={output} />)
    const log = screen.getByRole('log')
    expect(log.querySelectorAll('p')).toHaveLength(4)
    expect(log.textContent).not.toContain('Starting DSH connection')
    expect(screen.getByRole('button', { name: 'Expand logs' }).getAttribute('aria-controls')).toBe(log.id)
    fireEvent.click(screen.getByRole('button', { name: 'Expand logs' }))
    expect(log.querySelectorAll('p')).toHaveLength(8)
    expect(log.textContent).toContain('Starting DSH connection')
    expect(screen.getByRole('button', { name: 'Collapse logs' }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse logs' }))
    expect(log.querySelectorAll('p')).toHaveLength(4)
    rerender(<RuntimeConnectionView state={{ kind: 'connected' }} output={output} loadingSessionCatalog />)
    expect(log.querySelectorAll('p')).toHaveLength(4)
    expect(log.lastElementChild?.textContent).toContain('Loading workspaces and sessions')
  })

  it('distinguishes unavailable discovery candidates from actual errors', () => {
    render(
      <RuntimeConnectionView
        state={{ kind: 'starting' }}
        output={[
          {
            ...found,
            phase: 'verification',
            status: 'unavailable',
            attempt: 1,
            candidateSource: 'configured',
          },
          { ...found, id: 3, phase: 'verification', status: 'failed', attempt: 2, code: 'AUTH_REQUIRED' },
        ]}
      />,
    )
    const log = screen.getByRole('log')
    expect(log.querySelector('[data-status="unavailable"]')?.textContent).toContain(
      'Candidate unavailable; continuing discovery',
    )
    expect(log.querySelectorAll('[data-status="failed"]')).toHaveLength(1)
    expect(log.querySelector('[data-status="failed"]')?.textContent).toContain('AUTH_REQUIRED')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it.each([
    ['idle', 'Preparing DSH connection'],
    ['discovering', 'Finding DSH'],
    ['locating-runtime', 'Looking for DSH'],
    ['starting', 'Starting DSH'],
    ['connecting', 'Connecting to DSH'],
    ['stopping', 'Disconnecting from DSH'],
  ] as const)('shows one heading and an indeterminate activity indicator for %s', (kind, title) => {
    render(<RuntimeConnectionView state={{ kind }} />)
    expect(screen.getByRole('heading', { name: title })).toBeDefined()
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
    expect(screen.getByRole('log', { name: 'Connection output' })).toBeDefined()
    expect(screen.queryByRole('list')).toBeNull()
    expect(
      document.querySelector(
        '.dsh-runtime-connection__hint,.dsh-runtime-connection__next,.dsh-runtime-connection__wait',
      ),
    ).toBeNull()
  })

  it.each([
    ['discovery', 'Finding a DSH instance'],
    ['authorization', 'Preparing DSH access'],
    ['verification', 'Verifying DSH connection'],
    ['initialization', 'Initializing DSH services'],
  ] as const)('reflects the active Host operation %s', (phase, title) => {
    render(<RuntimeConnectionView state={{ kind: 'connecting', phase }} output={[first, found]} />)
    expect(screen.getByRole('heading', { name: title })).toBeDefined()
  })

  it('renders actual results, versions, sources and failure codes in one output region', () => {
    render(
      <RuntimeConnectionView
        state={{ kind: 'connecting', phase: 'verification' }}
        output={[
          first,
          found,
          {
            id: 3,
            time: first.time,
            elapsedMs: 440,
            phase: 'verification',
            status: 'failed',
            attempt: 1,
            candidateSource: 'configured',
            code: 'PROTOCOL_ERROR',
          },
          {
            id: 4,
            time: first.time,
            elapsedMs: 510,
            phase: 'verification',
            status: 'succeeded',
            hostVersion: '0.2.1-rc.2',
            ownership: 'external',
          },
        ]}
      />,
    )
    const text = screen.getByRole('log').textContent
    expect(text).toContain('2 candidates')
    expect(text).toContain('candidate #1')
    expect(text).toContain('configured instance')
    expect(text).toContain('PROTOCOL_ERROR')
    expect(text).toContain('DSH 0.2.1-rc.2')
    expect(text).not.toMatch(/\+\d+(?:\.\d+)?s/u)
  })

  it('appends stable log rows and respects scrolling back through earlier output', () => {
    const { rerender } = render(<RuntimeConnectionView state={{ kind: 'connecting' }} output={[first]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand logs' }))
    const log = screen.getByRole('log')
    const row = log.firstElementChild
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
    })
    log.scrollTop = 200
    fireEvent.scroll(log)
    rerender(<RuntimeConnectionView state={{ kind: 'connecting' }} output={[first, found]} />)
    expect(log.firstElementChild).toBe(row)
    expect(log.scrollTop).toBe(200)
    log.scrollTop = 900
    fireEvent.scroll(log)
    rerender(
      <RuntimeConnectionView state={{ kind: 'connecting' }} output={[first, found, { ...found, id: 3 }]} />,
    )
    expect(log.scrollTop).toBe(1000)
  })

  it('opens full Output and Settings directly without polling diagnostics', () => {
    vi.useFakeTimers()
    const output = vi.fn().mockResolvedValue(undefined)
    const settings = vi.fn()
    render(
      <RuntimeConnectionView
        state={{ kind: 'starting' }}
        onShowDiagnosticsOutput={output}
        onOpenSettings={settings}
      />,
    )
    expect(vi.getTimerCount()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Open Output' }))
    fireEvent.click(screen.getByRole('button', { name: 'Connection settings' }))
    expect(output).toHaveBeenCalledOnce()
    expect(settings).toHaveBeenCalledOnce()
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
