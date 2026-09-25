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
  const result = render(
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
  // The card list collapses by default, so a test that inspects it opens the section first.
  fireEvent.click(screen.getByRole('button', { name: /Plugin configuration/u }))
  return result
}

describe('PluginConfiguration', () => {
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  it('collapses the whole card list by default and reveals it from the section header', () => {
    render(
      <PluginConfiguration
        snapshot={snapshot()}
        onReload={vi.fn().mockResolvedValue(snapshot())}
        onUpdateSetting={vi.fn().mockResolvedValue(undefined)}
        onUnsetSetting={vi.fn().mockResolvedValue(undefined)}
      />,
    )
    const toggle = screen.getByRole('button', { name: /Plugin configuration/u })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: /shell/u })).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: /shell/u })).toBeDefined()
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

    fireEvent.click(screen.getByRole('button', { name: /插件配置/u }))
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
    fireEvent.click(screen.getByLabelText(/sandboxMode/u))
    fireEvent.click(screen.getByRole('option', { name: 'strict' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onUpdateSetting).toHaveBeenCalledWith('shell.sandboxMode', 'strict'))
    expect(
      screen.getByLabelText(/stream/u).querySelector('.dsh-select-menu__trigger-text')?.textContent,
    ).toBe('true')
  })
})

describe('structured plugin settings', () => {
  afterEach(() => cleanup())
  function structuredSnapshot(): DshSettingsSnapshot {
    const base = snapshot()
    return {
      ...base,
      schema: {
        ...base.schema,
        fields: [
          {
            path: 'shell.options',
            label: 'Options',
            type: 'object',
            required: false,
            restartRequired: false,
          },
          {
            path: 'shell.arguments',
            label: 'Arguments',
            type: 'array',
            required: false,
            restartRequired: false,
          },
        ],
      },
      values: { shell: { options: { enabled: true }, arguments: ['first'] } },
    }
  }
  it('round-trips objects and arrays as structured values', async () => {
    const value = structuredSnapshot()
    const onUpdateSetting = vi.fn().mockResolvedValue(undefined)
    renderConfiguration({ snapshot: value, onUpdateSetting, onReload: vi.fn().mockResolvedValue(value) })
    fireEvent.click(screen.getByRole('button', { name: /shell/u }))
    expect(screen.getByLabelText<HTMLTextAreaElement>(/^Options/u).value).toContain('"enabled": true')
    fireEvent.change(screen.getByLabelText(/^Options/u), { target: { value: '{"enabled":false}' } })
    fireEvent.change(screen.getByLabelText(/^Arguments/u), { target: { value: '["second", 2]' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onUpdateSetting).toHaveBeenCalledWith('shell.arguments', ['second', 2]))
    expect(onUpdateSetting).toHaveBeenCalledWith('shell.options', { enabled: false })
  })
  it.each(['{broken', '[]', 'null', '42', '{"limit":1e400}', '{"nested":[-1e400]}'])(
    'blocks an invalid object draft: %s',
    (text) => {
      const onUpdateSetting = vi.fn()
      renderConfiguration({ snapshot: structuredSnapshot(), onUpdateSetting })
      fireEvent.click(screen.getByRole('button', { name: /shell/u }))
      fireEvent.change(screen.getByLabelText(/^Options/u), { target: { value: text } })
      expect(screen.getByLabelText(/^Options/u).getAttribute('aria-invalid')).toBe('true')
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
      expect(onUpdateSetting).not.toHaveBeenCalled()
    },
  )
  it('does not offer a JSON editor for containers with redacted credentials', () => {
    const value = structuredSnapshot()
    renderConfiguration({
      snapshot: {
        ...value,
        schema: {
          ...value.schema,
          namespaces: [
            {
              ns: 'shell',
              applies: 'live',
              revision: 1,
              userFields: [],
              secrets: [{ field: 'options.token', set: true }],
            },
          ],
        },
      },
    })
    fireEvent.click(screen.getByRole('button', { name: /shell/u }))
    expect(screen.queryByLabelText(/^Options/u)).toBeNull()
    expect(screen.getByLabelText(/^Arguments/u)).toBeDefined()
  })
})

describe('plugin string settings preserve authored values', () => {
  afterEach(() => cleanup())
  it.each(['', '  padded value  '])(
    'stores the exact string %j instead of resetting or trimming it',
    async (text) => {
      const base = snapshot()
      const onUpdateSetting = vi.fn().mockResolvedValue(undefined)
      const onUnsetSetting = vi.fn().mockResolvedValue(undefined)
      renderConfiguration({
        snapshot: {
          ...base,
          schema: {
            ...base.schema,
            fields: [
              {
                path: 'shell.label',
                label: 'Label',
                type: 'string',
                required: false,
                restartRequired: false,
              },
            ],
          },
          values: { shell: { label: 'old' } },
        },
        onUpdateSetting,
        onUnsetSetting,
      })
      fireEvent.click(screen.getByRole('button', { name: /shell/u }))
      fireEvent.change(screen.getByLabelText(/^Label/u), { target: { value: text } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(onUpdateSetting).toHaveBeenCalledWith('shell.label', text))
      expect(onUnsetSetting).not.toHaveBeenCalled()
    },
  )
})

describe('literal enum settings', () => {
  afterEach(() => cleanup())
  it.each(['', '  exact  '])('saves the declared enum value %j unchanged', async (value) => {
    const base = snapshot()
    const onUpdateSetting = vi.fn().mockResolvedValue(undefined)
    const onUnsetSetting = vi.fn().mockResolvedValue(undefined)
    renderConfiguration({
      snapshot: {
        ...base,
        schema: {
          ...base.schema,
          fields: [
            {
              path: 'shell.mode',
              label: 'Mode',
              type: 'enum',
              enumValues: ['initial', value],
              required: false,
              restartRequired: false,
            },
          ],
        },
        values: { shell: { mode: 'initial' } },
      },
      onUpdateSetting,
      onUnsetSetting,
    })
    fireEvent.click(screen.getByRole('button', { name: /shell/u }))
    fireEvent.click(screen.getByLabelText(/^Mode/u))
    // The literal is picked by its own text: the accessible name of a choice that
    // is empty or padded would not survive whitespace normalisation.
    const option = Array.from(
      document.querySelectorAll<HTMLSpanElement>('.dsh-select-menu__option > span'),
    ).findLast((entry) => entry.textContent === value)
    if (option === undefined) throw new Error(`The declared enum value has no choice: ${value}`)
    fireEvent.click(option)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onUpdateSetting).toHaveBeenCalledWith('shell.mode', value))
    expect(onUnsetSetting).not.toHaveBeenCalled()
  })
})
