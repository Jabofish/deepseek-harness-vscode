// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentPresetPluginGroup, PluginInventorySnapshot } from '@dsh-vscode/domain'
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
        meta: { description: 'Gateway runtime details', error: 'Gateway initialization failed.' },
        enabled: true,
        fiberPhase: 'failed',
      },
    ],
    agentPresets: [
      {
        id: 'standard',
        name: 'Standard mode',
        trust: 'system',
        isDefault: true,
        rows: [
          {
            entryId: 'session-only',
            moduleName: 'dsh-agent-session-only',
            enabled: true,
            fiberPhase: 'active',
          },
          {
            entryId: null,
            moduleName: 'cordis-plugin-dynamic',
            enabled: 'conditional',
            condition: 'ctx.available',
            fiberPhase: null,
          },
          {
            entryId: 'disabled-row',
            moduleName: 'cordis-plugin-hidden',
            enabled: false,
            fiberPhase: 'active',
          },
        ],
      },
      {
        id: 'analysis',
        name: 'Analysis mode',
        trust: 'user',
        isDefault: false,
        rows: [
          {
            entryId: 'analysis-only',
            moduleName: 'dsh-agent-analysis-only',
            enabled: true,
            fiberPhase: 'pending',
          },
        ],
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

function count(region: HTMLElement, attribute: 'data-plugin-count' | 'data-plugin-total'): string | null {
  return region.querySelector(`[${attribute}]`)?.getAttribute(attribute) ?? null
}

describe('PluginInventory', () => {
  afterEach(() => cleanup())

  it('defaults to the host default mode and separates session composition from global inventory', async () => {
    renderInventory()

    const selector = await screen.findByRole('combobox', { name: 'Choose the Agent mode to inspect' })
    expect((selector as HTMLSelectElement).value).toBe('standard')
    expect(within(selector).getByRole('option', { name: 'Standard mode (Default)' })).toBeDefined()

    const session = screen.getByRole('region', { name: 'Session plugins' })
    const global = screen.getByRole('region', { name: 'Global plugins' })
    expect(session.getAttribute('data-agent-preset-id')).toBe('standard')
    expect(count(session, 'data-plugin-count')).toBe('3')
    expect(count(session, 'data-plugin-total')).toBe('3')
    expect(count(global, 'data-plugin-count')).toBe('4')
    expect(count(global, 'data-plugin-total')).toBe('4')
    expect(within(session).getByText('agent-session-only')).toBeDefined()
    expect(within(session).getByText('dynamic')).toBeDefined()
    expect(within(global).getByText('ui-settings')).toBeDefined()
    expect(within(global).getByText('shell-tools')).toBeDefined()
  })

  it('uses the first host mode when the roster has no default', async () => {
    const modes: readonly AgentPresetPluginGroup[] = [
      { id: 'first', name: 'First mode', trust: 'system', isDefault: false, rows: [] },
      { id: 'second', name: 'Second mode', trust: 'user', isDefault: false, rows: [] },
    ]
    renderInventory(vi.fn().mockResolvedValue({ entries: [], agentPresets: modes }))

    const selector = await screen.findByRole('combobox', { name: 'Choose the Agent mode to inspect' })
    expect((selector as HTMLSelectElement).value).toBe('first')
    expect(screen.getByRole('region', { name: 'Session plugins' }).getAttribute('data-agent-preset-id')).toBe(
      'first',
    )
  })

  it('switches only the viewed composition when the mode selector changes', async () => {
    const load = vi.fn().mockResolvedValue(snapshotFixture())
    renderInventory(load)

    const selector = await screen.findByRole('combobox', { name: 'Choose the Agent mode to inspect' })
    fireEvent.change(selector, { target: { value: 'analysis' } })

    expect((selector as HTMLSelectElement).value).toBe('analysis')
    const session = screen.getByRole('region', { name: 'Session plugins' })
    expect(session.getAttribute('data-agent-preset-id')).toBe('analysis')
    expect(within(session).getByText('agent-analysis-only')).toBeDefined()
    expect(within(session).queryByText('agent-session-only')).toBeNull()
    expect(screen.getByRole('region', { name: 'Global plugins' })).toBeDefined()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('keeps the selected mode while available and falls back to the refreshed default when it disappears', async () => {
    const before = snapshotFixture()
    const after: PluginInventorySnapshot = {
      entries: before.entries,
      agentPresets: [
        {
          id: 'first-after-refresh',
          name: 'First after refresh',
          trust: 'user',
          isDefault: false,
          rows: [],
        },
        {
          id: 'new-default',
          name: 'New default',
          trust: 'system',
          isDefault: true,
          rows: [],
        },
      ],
    }
    const load = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after)
    const view = render(<PluginInventory revision={0} onLoadInventory={load} />)

    const selector = await screen.findByRole('combobox', { name: 'Choose the Agent mode to inspect' })
    fireEvent.change(selector, { target: { value: 'analysis' } })
    expect((selector as HTMLSelectElement).value).toBe('analysis')

    view.rerender(<PluginInventory revision={1} onLoadInventory={load} />)
    await waitFor(() => expect((selector as HTMLSelectElement).value).toBe('new-default'))
    expect(screen.getByRole('region', { name: 'Session plugins' }).getAttribute('data-agent-preset-id')).toBe(
      'new-default',
    )
  })

  it('renders the global empty state with no selector or session section for an empty roster', async () => {
    renderInventory(vi.fn().mockResolvedValue({ entries: [], agentPresets: [] }))

    expect(await screen.findByText('No plugins are available.')).toBeDefined()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Session plugins' })).toBeNull()
    expect(count(screen.getByRole('region', { name: 'Global plugins' }), 'data-plugin-count')).toBe('0')
  })

  it('expands a plugin card into its details and exposes a valid disclosure relationship', async () => {
    renderInventory()

    const global = await screen.findByRole('region', { name: 'Global plugins' })
    const card = within(global).getByRole('button', { name: /ui-settings/u })
    expect(card.getAttribute('aria-expanded')).toBe('false')
    expect(card.hasAttribute('aria-controls')).toBe(false)
    fireEvent.click(card)

    expect(card.getAttribute('aria-expanded')).toBe('true')
    const detailId = card.getAttribute('aria-controls')
    expect(detailId).not.toBeNull()
    const details = document.getElementById(detailId as string)
    expect(details).not.toBeNull()
    expect(within(details as HTMLElement).getByText('ui-settings')).toBeDefined()
    expect(within(details as HTMLElement).getAllByText('Mounted').length).toBeGreaterThan(0)
    expect(within(details as HTMLElement).getAllByText('Enabled').length).toBeGreaterThan(0)

    fireEvent.click(card)
    expect(card.getAttribute('aria-expanded')).toBe('false')
  })

  it('projects conditional and disabled composition rows without inventing live status', async () => {
    renderInventory()

    const session = await screen.findByRole('region', { name: 'Session plugins' })
    const conditional = within(session).getByRole('button', { name: /dynamic/u })
    expect(conditional.textContent).toContain('Conditional')
    fireEvent.click(conditional)
    const conditionalCard = conditional.closest('[data-plugin-scope="session"]') as HTMLElement
    expect(within(conditionalCard).getByText('ctx.available')).toBeDefined()
    expect(within(conditionalCard).queryByRole('img')).toBeNull()
    expect(within(conditionalCard).queryByText('Cordis status')).toBeNull()

    const disabled = within(session).getByRole('button', { name: /hidden/u })
    expect(disabled.textContent).toContain('Disabled')
    fireEvent.click(disabled)
    const disabledCard = disabled.closest('[data-plugin-scope="session"]') as HTMLElement
    expect(within(disabledCard).queryByRole('img')).toBeNull()
    expect(within(disabledCard).queryByText('Cordis status')).toBeNull()
  })

  it('preserves loader metadata and failure details', async () => {
    renderInventory()

    const global = await screen.findByRole('region', { name: 'Global plugins' })
    const card = within(global).getByRole('button', { name: /failing-gateway/u })
    fireEvent.click(card)
    const details = card.parentElement?.querySelector('.dsh-plugin-inventory__card-details')
    expect(details).not.toBeNull()
    expect(within(details as HTMLElement).getByText('Gateway runtime details')).toBeDefined()
    expect(within(details as HTMLElement).getByRole('alert').textContent).toBe(
      'Gateway initialization failed.',
    )
  })

  it('searches both visible sections and reports independent match and total counts', async () => {
    renderInventory()

    const session = await screen.findByRole('region', { name: 'Session plugins' })
    const global = screen.getByRole('region', { name: 'Global plugins' })
    const search = screen.getByRole('searchbox', { name: 'Search plugins' })

    fireEvent.change(search, { target: { value: 'SESSION-ONLY' } })
    expect(within(session).getByText('agent-session-only')).toBeDefined()
    expect(within(global).queryByText('ui-settings')).toBeNull()
    expect(count(session, 'data-plugin-count')).toBe('1')
    expect(count(session, 'data-plugin-total')).toBe('3')
    expect(count(global, 'data-plugin-count')).toBe('0')
    expect(count(global, 'data-plugin-total')).toBe('4')

    fireEvent.change(search, { target: { value: 'shell-tools' } })
    expect(within(session).queryByText('agent-session-only')).toBeNull()
    expect(within(global).getByText('shell-tools')).toBeDefined()
    expect(screen.getByText('1 of 4')).toBeDefined()

    fireEvent.change(search, { target: { value: 'no-such-plugin' } })
    expect(screen.getByRole('status').textContent).toContain('No matching plugins.')
  })

  it('collapses an expanded row when search filters it out', async () => {
    renderInventory()

    const session = await screen.findByRole('region', { name: 'Session plugins' })
    const card = within(session).getByRole('button', { name: /dynamic/u })
    fireEvent.click(card)
    expect(card.getAttribute('aria-expanded')).toBe('true')
    expect(
      within(card.closest('[data-plugin-scope="session"]') as HTMLElement).getByText('ctx.available'),
    ).toBeDefined()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search plugins' }), {
      target: { value: 'shell-tools' },
    })
    expect(within(session).queryByText('dynamic')).toBeNull()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search plugins' }), { target: { value: '' } })
    expect(
      within(session)
        .getByRole('button', { name: /dynamic/u })
        .getAttribute('aria-expanded'),
    ).toBe('false')
  })

  it('preserves the broken-composition alert and preset identity', async () => {
    renderInventory(
      vi.fn().mockResolvedValue({
        entries: [],
        agentPresets: [
          {
            id: 'broken-mode',
            name: 'Broken mode',
            trust: 'user',
            isDefault: true,
            broken: 'Composition unavailable',
            rows: [],
          },
        ],
      }),
    )

    const session = await screen.findByRole('region', { name: 'Session plugins' })
    expect(within(session).getByRole('alert').textContent).toBe('Composition unavailable')
    expect(within(session).getByText('broken-mode')).toBeDefined()
  })

  it('offers a retry after a failed read and recovers', async () => {
    const onLoadInventory = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(snapshotFixture())
    renderInventory(onLoadInventory)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('temporarily unavailable'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('ui-settings')).toBeDefined()
  })
})

it('refreshes invalidated inventory and ignores an older in-flight snapshot', async () => {
  const pending: Array<(value: PluginInventorySnapshot) => void> = []
  const load = vi.fn(() => new Promise<PluginInventorySnapshot>((resolve) => pending.push(resolve)))
  const view = render(<PluginInventory revision={0} onLoadInventory={load} />)
  view.rerender(<PluginInventory revision={1} onLoadInventory={load} />)
  await act(async () => {
    pending[1]?.({ entries: [] })
    await Promise.resolve()
  })
  expect(screen.getByText('No plugins are available.')).toBeDefined()
  await act(async () => {
    pending[0]?.(snapshotFixture())
    await Promise.resolve()
  })
  expect(screen.queryByText('ui-settings')).toBeNull()
  view.rerender(<PluginInventory revision={1} onLoadInventory={() => load()} />)
  expect(load).toHaveBeenCalledTimes(2)
  view.unmount()
})
