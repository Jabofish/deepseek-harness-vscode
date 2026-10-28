// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentPresetRoster } from '@dsh-vscode/domain'
import { PluginCreatorAction } from './PluginCreatorAction.js'
import { OptionalBundleManager } from './OptionalBundleManager.js'

afterEach(cleanup)
const ready: AgentPresetRoster = {
  authorable: false,
  presets: [{ id: 'cordis', trust: 'system', isDefault: false }],
}

describe('plugin Creator shortcut', () => {
  it('starts the existing draft flow from the collapsed plugin panel only once', async () => {
    let settle!: () => void
    const start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        }),
    )
    render(
      <OptionalBundleManager
        onLoadPresetRoster={() => Promise.resolve(ready)}
        onStartCreatorDraft={start}
        featureRequest={<T,>(): Promise<T> =>
          Promise.resolve({ kind: 'plugin.bundles', available: false, bundles: [], plugins: [] } as T)
        }
      />,
    )
    const button = screen.getByRole('button', { name: 'Create a plugin' })
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
    fireEvent.click(button)
    fireEvent.click(button)
    expect(start).toHaveBeenCalledTimes(1)
    await act(async () => {
      settle()
      await Promise.resolve()
    })
  })

  it.each([
    undefined,
    { authorable: false, presets: [] },
    { authorable: false, presets: [{ id: 'cordis', trust: 'system', broken: 'invalid' }] },
  ])('does not start a missing or broken Creator (%j)', async (roster) => {
    const start = vi.fn(() => Promise.resolve())
    render(
      <PluginCreatorAction
        loadRoster={() => Promise.resolve(roster as AgentPresetRoster | undefined)}
        startDraft={start}
      />,
    )
    const button = screen.getByRole('button', { name: 'Create a plugin' })
    await waitFor(() => expect(button.title).toMatch(/unavailable|not available/i))
    fireEvent.click(button)
    expect(start).not.toHaveBeenCalled()
  })
})
