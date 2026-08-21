// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RuntimeMissingView } from './RuntimeMissingView.js'

describe('RuntimeMissingView', () => {
  afterEach(() => cleanup())

  it('explains the setup path and exposes install, selection, command, retry, and docs actions', () => {
    const onOpenSettings = vi.fn()
    render(
      <RuntimeMissingView
        searchedLocations={['/usr/bin/dsh', '/usr/bin/dsh']}
        busyAction={undefined}
        onAction={vi.fn()}
        onRetry={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    )

    expect(screen.getByRole('heading', { name: "DeepSeek Harness isn't ready yet" })).toBeDefined()
    expect(screen.getByText(/DSH runs locally in the VS Code Extension Host/)).toBeDefined()
    expect(screen.getByText(/the extension reconnects automatically/)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Install DSH' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Select DSH' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Docs' })).toBeDefined()
    expect(screen.getByText('Searched locations (1)')).toBeDefined()
  })
})
