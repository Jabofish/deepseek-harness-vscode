// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionSettingsCard } from './ExtensionSettingsCard.js'

describe('ExtensionSettingsCard', () => {
  afterEach(() => cleanup())

  it('opens VS Code settings and clears credentials only after a second press', async () => {
    const onOpen = vi.fn(() => Promise.resolve())
    const onClearCredentials = vi.fn(() => Promise.resolve())
    render(<ExtensionSettingsCard onOpen={onOpen} onClearCredentials={onClearCredentials} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open extension settings' }))
    expect(onOpen).toHaveBeenCalledOnce()
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Clear external connection credentials' }))
    expect(onClearCredentials).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Press again to clear the saved credentials' }))
    expect(onClearCredentials).toHaveBeenCalledOnce()
    expect(await screen.findByText('Saved credentials cleared.')).toBeDefined()
  })
})
