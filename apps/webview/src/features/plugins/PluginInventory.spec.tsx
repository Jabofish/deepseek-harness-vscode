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
        meta: { description: 'Gateway runtime details', error: 'Gateway initialization failed.' },
        enabled: true,
        fiberPhase: 'failed',
      },
    ],
    agentPresets: [
      {
        id: 'standard',
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

function modeTrigger(): HTMLButtonElement {
  return screen.getByRole('button', {
    name: /^(?:Choose the Agent mode to inspect|选择要查看的 Agent 模式)(?::.*)?$/u,
  })
}

function modeTriggerLabel(): string {
  return modeTrigger().querySelector('.dsh-select-menu__trigger-text')?.textContent ?? ''
}

/** The mode selector is an anchored menu: open its trigger, then pick the mode. */

/** Both inventory groups start collapsed, so a test has to open the one it inspects. */
function openGroup(name: string): void {
  fireEvent.click(screen.getByRole('button', { name }))
}

describe('PluginInventory', () => {
  afterEach(() => {
    cleanup()
    document.documentElement.lang = 'en'
    window.localStorage.clear()
  })

  it('defaults to the host default mode and separates session composition from global inventory', async () => {
    renderInventory()

    await screen.findByRole('button', { name: /^Choose the Agent mode to inspect/u })
    expect(modeTriggerLabel()).toBe('Standard (Default)')
    fireEvent.click(modeTrigger())
    expect(screen.getByRole('option', { name: 'Standard (Default)' })).toBeDefined()
    fireEvent.click(modeTrigger())

    const session = screen.getByRole('region', { name: 'Session plugins' })
    const global = screen.getByRole('region', { name: 'Global plugins' })
    expect(session.getAttribute('data-agent-preset-id')).toBe('standard')
    expect(count(session, 'data-plugin-count')).toBe('3')
    expect(count(session, 'data-plugin-total')).toBe('3')
    expect(count(global, 'data-plugin-count')).toBe('4')
    expect(count(global, 'data-plugin-total')).toBe('4')
    expect(
      within(session).getByRole('button', { name: 'Session plugins' }).getAttribute('aria-expanded'),
    ).toBe('false')
    expect(within(global).queryByText('ui-settings')).toBeNull()

    openGroup('Session plugins')
    openGroup('Global plugins')
    expect(
      within(session).getByRole('button', { name: 'Session plugins' }).getAttribute('aria-expanded'),
    ).toBe('true')
    expect(within(session).getByText('agent-session-only')).toBeDefined()
    expect(within(session).getByText('dynamic')).toBeDefined()
    expect(within(global).getByText('ui-settings')).toBeDefined()
    expect(within(global).getByText('shell-tools')).toBeDefined()
  })

  it('preserves the broken-composition alert and preset identity', async () => {
    renderInventory(
      vi.fn().mockResolvedValue({
        entries: [],
        agentPresets: [
          {
            id: 'broken-mode',
            name: 'Broken mode',
            isDefault: true,
            broken: 'Composition unavailable',
            rows: [],
          },
        ],
      }),
    )

    const session = await screen.findByRole('region', { name: 'Session plugins' })
    expect(within(session).getByRole('alert').textContent).toBe('Composition unavailable')
    openGroup('Session plugins')
    expect(within(session).getByText('broken-mode')).toBeDefined()
  })

  it('offers a retry after a failed read and recovers', async () => {
    const onLoadInventory = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(snapshotFixture())
    renderInventory(onLoadInventory)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('temporarily unavailable'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('region', { name: 'Global plugins' })
    openGroup('Global plugins')
    expect(await screen.findByText('ui-settings')).toBeDefined()
  })
})
