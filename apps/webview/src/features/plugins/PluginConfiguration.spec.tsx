// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DshSettingsSchema } from '@dsh-vscode/domain'
import type { DshSettingsSnapshot } from '../../app/store.js'
import { I18nProvider } from '../../i18n.js'
import { PluginConfiguration } from './PluginConfiguration.js'

function snapshot(): DshSettingsSnapshot {
  const namespaces: DshSettingsSchema['namespaces'] = [
    { ns: 'shell', applies: 'live', revision: 1, userFields: ['timeoutMs'], secrets: [] },
    { ns: 'agent-loop', applies: 'live', revision: 2, userFields: [], secrets: [] },
    {
      ns: 'web-search-deepseek',
      applies: 'live',
      revision: 3,
      userFields: [],
      secrets: [{ field: 'apiKey', set: false }],
    },
  ]
  return {
    schema: {
      version: 'test',
      writable: true,
      hasDocument: false,
      fields: [
        {
          path: 'shell.timeoutMs',
          label: 'timeoutMs',
          type: 'number',
          required: false,
          restartRequired: false,
        },
        {
          path: 'shell.maxOutputBytes',
          label: 'maxOutputBytes',
          type: 'number',
          required: false,
          restartRequired: false,
        },
        {
          path: 'agent-loop.maxParallelToolCalls',
          label: 'maxParallelToolCalls',
          type: 'number',
          required: false,
          restartRequired: false,
        },
        {
          path: 'web-search-deepseek.baseURL',
          label: 'baseURL',
          type: 'string',
          required: false,
          restartRequired: false,
        },
        {
          path: 'web-search-deepseek.maxUses',
          label: 'maxUses',
          type: 'number',
          required: false,
          restartRequired: false,
        },
      ],
      namespaces,
    },
    values: {
      shell: { timeoutMs: 120_000, maxOutputBytes: 64_000 },
      'agent-loop': { maxParallelToolCalls: 10 },
      'web-search-deepseek': { apiKeyEnv: 'DEEPSEEK_API_KEY', maxUses: 5 },
    },
  }
}

function renderConfiguration(
  overrides: Partial<Parameters<typeof PluginConfiguration>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <PluginConfiguration
      snapshot={snapshot()}
      onReload={vi.fn().mockResolvedValue(snapshot())}
      onUpdateSetting={vi.fn().mockResolvedValue(undefined)}
      onUnsetSetting={vi.fn().mockResolvedValue(undefined)}
      onConfigureCredential={vi.fn().mockResolvedValue(true)}
      onRemoveCredential={vi.fn().mockResolvedValue(undefined)}
      {...overrides}
    />,
  )
}

describe('PluginConfiguration', () => {
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  it('shows the three upstream plugin configuration cards and saves staged settings', async () => {
    const onUpdateSetting = vi.fn().mockResolvedValue(undefined)
    const onReload = vi.fn().mockResolvedValue(snapshot())
    renderConfiguration({ onUpdateSetting, onReload })

    expect(screen.getByText('Shell')).toBeDefined()
    expect(screen.getByText('Agent loop')).toBeDefined()
    expect(screen.getByText('Web search')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: /Shell/u }))
    const timeout = screen.getByLabelText(/Command timeout \(ms\)/u)
    fireEvent.change(timeout, { target: { value: '90000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onUpdateSetting).toHaveBeenCalledWith('shell.timeoutMs', 90000))
    expect(onReload).toHaveBeenCalled()
  })

  it('localizes the plugin cards and keeps the secret in the host flow', async () => {
    window.localStorage.setItem('dsh-webview-locale', 'zh')
    const onConfigureCredential = vi.fn().mockResolvedValue(true)
    render(
      <I18nProvider>
        <PluginConfiguration
          snapshot={snapshot()}
          onReload={vi.fn().mockResolvedValue(snapshot())}
          onUpdateSetting={vi.fn().mockResolvedValue(undefined)}
          onUnsetSetting={vi.fn().mockResolvedValue(undefined)}
          onConfigureCredential={onConfigureCredential}
          onRemoveCredential={vi.fn().mockResolvedValue(undefined)}
        />
      </I18nProvider>,
    )

    expect(screen.getByText('终端')).toBeDefined()
    expect(screen.getByText('Agent 循环')).toBeDefined()
    expect(screen.getByText('网页搜索')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /网页搜索/u }))
    fireEvent.click(screen.getByRole('button', { name: '配置 API Key' }))
    await waitFor(() => expect(onConfigureCredential).toHaveBeenCalledWith('DEEPSEEK_API_KEY'))
  })

  it('uses the shared SVG chevron for expandable plugin cards', () => {
    renderConfiguration()

    const card = screen.getByRole('button', { name: /Shell/u })
    const chevron = card.querySelector('.dsh-plugin-configuration__chevron')

    expect(chevron?.querySelector('svg.dsh-icon')).not.toBeNull()
    expect(chevron?.textContent).toBe('')

    fireEvent.click(card)

    expect(chevron?.classList.contains('dsh-plugin-configuration__chevron--open')).toBe(true)
  })
})
