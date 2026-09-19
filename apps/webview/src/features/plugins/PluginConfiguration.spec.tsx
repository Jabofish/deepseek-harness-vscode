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

  it('lists every namespace the host describes and saves staged settings', async () => {
    const onUpdateSetting = vi.fn().mockResolvedValue(undefined)
    const onReload = vi.fn().mockResolvedValue(snapshot())
    renderConfiguration({ onUpdateSetting, onReload })

    expect(screen.getByText('shell')).toBeDefined()
    expect(screen.getByText('agent-loop')).toBeDefined()
    expect(screen.getByText('web-search-deepseek')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: /shell/u }))
    const timeout = screen.getByLabelText(/timeoutMs/u)
    fireEvent.change(timeout, { target: { value: '90000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onUpdateSetting).toHaveBeenCalledWith('shell.timeoutMs', 90000))
    expect(onReload).toHaveBeenCalled()
  })

  it('keeps the secret in the host flow under the reference the namespace states', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: /web-search-deepseek/u }))
    expect(screen.getByText(/DEEPSEEK_API_KEY/u)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '配置 API Key' }))
    await waitFor(() => expect(onConfigureCredential).toHaveBeenCalledWith('DEEPSEEK_API_KEY'))
  })

  it('uses the shared SVG chevron for expandable plugin cards', () => {
    renderConfiguration()

    const card = screen.getByRole('button', { name: /shell/u })
    const chevron = card.querySelector('.dsh-plugin-configuration__chevron')

    expect(chevron?.querySelector('svg.dsh-icon')).not.toBeNull()
    expect(chevron?.textContent).toBe('')

    fireEvent.click(card)

    expect(chevron?.classList.contains('dsh-plugin-configuration__chevron--open')).toBe(true)
  })

  it('renders a choice control for described enum and boolean fields', async () => {
    const base = snapshot()
    const onUpdateSetting = vi.fn().mockResolvedValue(undefined)
    renderConfiguration({
      onUpdateSetting,
      onReload: vi.fn().mockResolvedValue(base),
      snapshot: {
        ...base,
        schema: {
          ...base.schema,
          fields: [
            ...base.schema.fields,
            {
              path: 'shell.sandboxMode',
              label: 'sandboxMode',
              type: 'enum',
              enumValues: ['off', 'strict'],
              required: false,
              restartRequired: false,
            },
            {
              path: 'shell.stream',
              label: 'stream',
              type: 'boolean',
              required: false,
              restartRequired: false,
            },
          ],
        },
        values: {
          ...base.values,
          shell: { timeoutMs: 120_000, maxOutputBytes: 64_000, sandboxMode: 'off', stream: true },
        },
      },
    })

    fireEvent.click(screen.getByRole('button', { name: /shell/u }))
    // A choice field stages the picked value; nothing is written until Save.
    fireEvent.change(screen.getByLabelText(/sandboxMode/u), { target: { value: 'strict' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onUpdateSetting).toHaveBeenCalledWith('shell.sandboxMode', 'strict'))
    expect(screen.getByLabelText(/stream/u)).toHaveProperty('value', 'true')
  })
})
