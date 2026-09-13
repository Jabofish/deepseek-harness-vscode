// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosticsSnapshot } from '@dsh-vscode/domain'
import { I18nProvider } from '../../i18n.js'
import { DiagnosticsDrawer } from './DiagnosticsDrawer.js'

const snapshot: DiagnosticsSnapshot = {
  extensionVersion: '0.1.11',
  state: 'failed',
  canReconnect: true,
  recentEvents: [],
}

describe('DiagnosticsDrawer', () => {
  afterEach(() => cleanup())

  it('loads on demand and wires recovery actions through the Host callbacks', async () => {
    const onRead = vi.fn().mockResolvedValue(snapshot)
    const onReconnect = vi.fn().mockResolvedValue(undefined)
    const onShowOutput = vi.fn().mockResolvedValue(undefined)
    render(
      <I18nProvider>
        <DiagnosticsDrawer onRead={onRead} onReconnect={onReconnect} onShowOutput={onShowOutput} />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Diagnostics' })).toBeDefined())
    expect(onRead).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(onReconnect).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Open output' }))
    await waitFor(() => expect(onShowOutput).toHaveBeenCalledOnce())
  })

  it('fails closed and offers a retry when the Host snapshot is unavailable', async () => {
    const onRead = vi.fn().mockResolvedValue(undefined)
    render(
      <I18nProvider>
        <DiagnosticsDrawer
          onRead={onRead}
          onReconnect={vi.fn().mockResolvedValue(undefined)}
          onShowOutput={vi.fn().mockResolvedValue(undefined)}
        />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('The diagnostics snapshot is unavailable.'),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Refresh diagnostics' }))
    await waitFor(() => expect(onRead).toHaveBeenCalledTimes(2))
  })
})
