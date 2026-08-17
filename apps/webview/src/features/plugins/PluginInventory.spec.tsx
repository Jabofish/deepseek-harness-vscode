// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginInventorySnapshot } from '@dsh-vscode/domain'
import { PluginInventory } from './PluginInventory.js'

function snapshotFixture(): PluginInventorySnapshot {
  return {
    entries: [
      {
        entryId: 'ui-settings',
        moduleName: '@deepseek-ai/dsh-client-ui-settings',
        enabled: true,
        fiberPhase: 'active',
      },
      {
        entryId: 'shell-tools',
        moduleName: '@deepseek-ai/dsh-host-shell-tools',
        enabled: true,
        fiberPhase: null,
      },
      {
        entryId: 'legacy-plugin',
        moduleName: 'cordis-plugin-legacy',
        enabled: false,
        fiberPhase: null,
      },
      {
        entryId: 'failing-gateway',
        moduleName: 'dsh-host-failing-gateway',
        enabled: true,
        fiberPhase: 'failed',
      },
    ],
  }
}

function renderInventory(
  onLoadInventory: () => Promise<PluginInventorySnapshot | undefined> = vi
    .fn()
    .mockResolvedValue(snapshotFixture()),
): ReturnType<typeof render> {
  return render(<PluginInventory onLoadInventory={onLoadInventory} />)
}

describe('PluginInventory', () => {
  afterEach(() => cleanup())

  it('renders one expandable card per loader entry with compact module names', async () => {
    renderInventory()
    await waitFor(() => expect(screen.getByText('Plugin list')).toBeDefined())
    expect(screen.getByText('ui-settings')).toBeDefined()
    expect(screen.getByText('shell-tools')).toBeDefined()
    expect(screen.getByText('legacy')).toBeDefined()
    expect(screen.getByText('failing-gateway')).toBeDefined()
    expect(screen.getByText('4')).toBeDefined()
  })

  it('expands a card into its entry id and facts, then collapses it', async () => {
    renderInventory()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'ui-settings, Mounted, Enabled' })).toBeDefined(),
    )
    const card = screen.getByRole('button', { name: 'ui-settings, Mounted, Enabled' })
    fireEvent.click(card)
    const details = document.querySelector('[data-loader-entry]')?.parentElement
    expect(details).toBeDefined()
    expect(within(details as HTMLElement).getByText('ui-settings')).toBeDefined()
    expect(within(details as HTMLElement).getByText('Mounted')).toBeDefined()
    expect(within(details as HTMLElement).getAllByText('Enabled').length).toBeGreaterThan(0)
    // A second click collapses the card again.
    fireEvent.click(card)
    expect(document.querySelector('[data-loader-entry]')).toBeNull()
  })

  it('omits the fiber phase for disabled entries, in both label and details', async () => {
    renderInventory()
    await waitFor(() => expect(screen.getByText('Plugin list')).toBeDefined())
    const disabled = screen.getByRole('button', { name: 'legacy, Disabled' })
    fireEvent.click(disabled)
    const card = disabled.closest('[data-plugin-entry="legacy-plugin"]') as HTMLElement
    expect(card).toBeDefined()
    expect(within(card).queryByText('Cordis status')).toBeNull()
    // The disabled card renders no phase dot at all.
    expect(within(card).queryByRole('img')).toBeNull()
  })

  it('filters the catalog by module name and entry id', async () => {
    renderInventory()
    await waitFor(() => expect(screen.getByText('Plugin list')).toBeDefined())
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'SHELL' } })
    expect(screen.getByText('shell-tools')).toBeDefined()
    expect(screen.queryByText('ui-settings')).toBeNull()
    expect(screen.getByText('1')).toBeDefined()
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'ui-settings' } })
    expect(screen.getByText('ui-settings')).toBeDefined()
    expect(screen.queryByText('shell-tools')).toBeNull()
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'no-such-plugin' } })
    expect(screen.getByText('No matching plugins.')).toBeDefined()
  })

  it('collapses an expanded card once the query filters it out', async () => {
    renderInventory()
    await waitFor(() => expect(screen.getByText('Plugin list')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'ui-settings, Mounted, Enabled' }))
    expect(document.querySelector('[data-plugin-entry="ui-settings"]')?.getAttribute('data-open')).toBe(
      'true',
    )
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'shell' } })
    expect(document.querySelector('[data-plugin-entry="ui-settings"]')).toBeNull()
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: '' } })
    expect(document.querySelector('[data-plugin-entry="ui-settings"]')?.getAttribute('data-open')).toBeNull()
  })

  it('reports an empty inventory without offering cards', async () => {
    renderInventory(vi.fn().mockResolvedValue({ entries: [] }))
    await waitFor(() => expect(screen.getByText('No plugins are available.')).toBeDefined())
    expect(screen.getByText('0')).toBeDefined()
  })

  it('offers a retry after a failed read and recovers', async () => {
    const onLoadInventory = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(snapshotFixture())
    renderInventory(onLoadInventory)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('temporarily unavailable'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('ui-settings')).toBeDefined())
  })
})
