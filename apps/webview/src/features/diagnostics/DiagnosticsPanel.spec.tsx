// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosticsSnapshot } from '@dsh-vscode/domain'
import { I18nProvider } from '../../i18n.js'
import { DiagnosticsPanel } from './DiagnosticsPanel.js'

const snapshot: DiagnosticsSnapshot = {
  extensionVersion: '0.1.10',
  dshVersion: '0.1.9',
  state: 'failed',
  endpointKind: 'managed',
  canReconnect: true,
  recentEvents: ['{"level":"error","event":"connection-state"}'],
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('DiagnosticsPanel', () => {
  it('renders safe state facts and exposes recovery/output/copy actions', async () => {
    const onReconnect = vi.fn().mockResolvedValue(undefined)
    const onShowOutput = vi.fn().mockResolvedValue(undefined)
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    render(
      <I18nProvider>
        <DiagnosticsPanel snapshot={snapshot} onReconnect={onReconnect} onShowOutput={onShowOutput} />
      </I18nProvider>,
    )

    expect(screen.getByRole('heading', { name: 'Diagnostics' })).toBeDefined()
    expect(screen.getByText('Connection failed')).toBeDefined()
    expect(screen.getByText('Managed DSH')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open output' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy report' }))

    await waitFor(() => {
      expect(onReconnect).toHaveBeenCalledOnce()
      expect(onShowOutput).toHaveBeenCalledOnce()
      expect(writeText).toHaveBeenCalledOnce()
      expect(screen.getByRole('status').textContent).toBe('Report copied')
    })
  })

  it('shows no recent events without inventing a failure detail', () => {
    render(
      <I18nProvider>
        <DiagnosticsPanel
          snapshot={{ ...snapshot, recentEvents: [], canReconnect: false }}
          onShowOutput={vi.fn().mockResolvedValue(undefined)}
        />
      </I18nProvider>,
    )

    expect(screen.getByText('No recent diagnostic events.')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
  })
})
