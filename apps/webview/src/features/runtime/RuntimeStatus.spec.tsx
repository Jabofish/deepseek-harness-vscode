// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeStatus } from './RuntimeStatus.js'

describe('RuntimeStatus', () => {
  afterEach(() => cleanup())

  it('keeps verbose connection details in a tooltip instead of squeezing the header', () => {
    const message = 'transport failure for /api/events.mux: HTTP 426'
    render(<RuntimeStatus state={{ kind: 'failed', message, retryable: true }} />)

    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Connection failed')
    expect(status.getAttribute('title')).toBe(message)
    expect(status.querySelector('.dsh-runtime-status__dot')).toBeDefined()
  })

  it('exposes connected state as a compact live status', () => {
    render(
      <RuntimeStatus
        state={{
          kind: 'connected',
          backend: {
            endpoint: { host: '127.0.0.1', port: 8765, baseUrl: 'http://127.0.0.1:8765' },
            ownership: 'managed',
            capabilities: { protocolVersion: '1', dshVersion: '0.1.0-rc.6', features: new Set() },
          },
        }}
      />,
    )

    expect(screen.getByRole('status').textContent).toBe('Connected')
  })
})
