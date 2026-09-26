// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelProvider } from '@dsh-vscode/domain'
import type { DshSettingsSnapshot } from '../../app/store.js'
import { I18nProvider } from '../../i18n.js'
import { ProviderSettingsEditor, type ProviderSettingChange } from './ProviderSettingsEditor.js'

const provider: ModelProvider = {
  id: 'deepseek',
  name: 'DeepSeek',
  kind: 'remote',
  configurable: true,
  settingsNs: 'llm-deepseek',
  fields: [
    {
      key: 'baseUrl',
      label: 'Base URL',
      secret: false,
      required: false,
      value: 'https://api.deepseek.com',
    },
  ],
}

function snapshot(models: readonly unknown[], namespace = 'llm-deepseek'): DshSettingsSnapshot {
  return {
    schema: {
      version: 'rc6-settings-v2',
      writable: true,
      hasDocument: false,
      fields: [
        {
          path: `${namespace}.models`,
          label: 'models',
          type: 'array',
          required: false,
          restartRequired: false,
        },
      ],
      namespaces: [{ ns: namespace, applies: 'live', revision: 3, userFields: [], secrets: [] }],
    },
    values: { [namespace]: { models } },
  }
}

function renderEditor(models: readonly unknown[] = [{ id: 'model-a', contextWindow: 128_000 }]): {
  readonly onSave: ReturnType<typeof vi.fn>
  readonly onClose: ReturnType<typeof vi.fn>
} {
  const onSave = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  render(
    <I18nProvider>
      <ProviderSettingsEditor
        provider={provider}
        settings={snapshot(models)}
        writable
        saving={false}
        onSave={onSave as (changes: readonly ProviderSettingChange[]) => Promise<void>}
        onDiscover={vi.fn().mockResolvedValue([])}
        onClose={onClose}
      />
    </I18nProvider>,
  )
  return { onSave, onClose }
}

function expandAdvanced(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Advanced model settings' }))
}

describe('ProviderSettingsEditor write-time validation', () => {
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    document.documentElement.lang = 'en'
  })

  it('refuses an unparsable capacity instead of sending it to the host', () => {
    const { onSave } = renderEditor()
    expandAdvanced()

    fireEvent.change(screen.getByLabelText('Context window'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(
      'Context window must be a positive integer, optionally using K or M.',
    )
  })

  it('refuses two models that share one id instead of sending a duplicate list', () => {
    const { onSave } = renderEditor([{ id: 'model-a' }, { id: 'model-b' }])

    const idInputs = screen.getAllByLabelText('Model ID')
    fireEvent.change(idInputs[1]!, { target: { value: 'model-a' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(
      'Every configured model must have a unique model ID.',
    )
  })

  it('still saves a valid capacity edit once, with the parsed number', async () => {
    const { onSave, onClose } = renderEditor()
    expandAdvanced()

    fireEvent.change(screen.getByLabelText('Context window'), { target: { value: '512K' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]?.[0]).toEqual([
      {
        kind: 'set',
        path: 'llm-deepseek.models',
        value: [{ id: 'model-a', contextWindow: 512_000 }],
      },
    ])
    // The form closes only after the host confirmed the write.
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('still reports an empty model id without saving', () => {
    const { onSave } = renderEditor([{ id: 'model-a' }])

    fireEvent.change(screen.getAllByLabelText('Model ID')[0]!, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('Every configured model needs a model ID.')
  })

  it('persists text-only DeepSeek input and drops image budgets', async () => {
    const { onSave, onClose } = renderEditor([
      {
        id: 'vision-model',
        inputModalities: ['text', 'image'],
        imagePixelBudget: 1_000_000,
        imageMaxBytes: 8_000_000,
      },
    ])
    expandAdvanced()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Image' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith([
        {
          kind: 'set',
          path: 'llm-deepseek.models',
          value: [{ id: 'vision-model', inputModalities: ['text'] }],
        },
      ], 3),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true))
  })

  it('unsets the explicit modality field to restore provider inheritance', async () => {
    const { onSave } = renderEditor([{ id: 'model-a', inputModalities: ['text', 'image'] }])
    expandAdvanced()

    fireEvent.click(screen.getByRole('button', { name: 'Use inherited' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith([
        { kind: 'set', path: 'llm-deepseek.models', value: [{ id: 'model-a' }] },
      ], 3),
    )
  })

  it('rejects clearing the last input type before a settings write', () => {
    const { onSave } = renderEditor([{ id: 'model-a', inputModalities: ['text'] }])
    expandAdvanced()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Text' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('Select at least one input type.')
  })

  it('stores DeepSeek Account models only in the independent account namespace', async () => {
    const accountProvider: ModelProvider = {
      id: 'deepseek-account',
      name: 'DeepSeek Account',
      kind: 'remote',
      configurable: true,
      settingsNs: 'llm-deepseek-account',
      fields: [],
    }
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    render(
      <I18nProvider>
        <ProviderSettingsEditor
          provider={accountProvider}
          settings={snapshot([{ id: 'account-model', inputModalities: ['text'] }], 'llm-deepseek-account')}
          writable
          saving={false}
          onSave={onSave as (changes: readonly ProviderSettingChange[]) => Promise<void>}
          onDiscover={vi.fn().mockResolvedValue([])}
          onClose={onClose}
        />
      </I18nProvider>,
    )

    expect(screen.queryByLabelText('Base URL')).toBeNull()
    expect(screen.queryByLabelText('API key')).toBeNull()
    expandAdvanced()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Image' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith([
        {
          kind: 'set',
          path: 'llm-deepseek-account.models',
          value: [{ id: 'account-model', inputModalities: ['text', 'image'] }],
        },
      ], 3),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true))
  })

  it('uses pi-ai input as the override field and inherits the configured provider default', async () => {
    const piProvider: ModelProvider = {
      id: 'openai',
      name: 'OpenAI',
      kind: 'remote',
      configurable: true,
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
      fields: [],
    }
    const settings: DshSettingsSnapshot = {
      schema: {
        version: 'rc6-settings-v2',
        writable: true,
        hasDocument: false,
        fields: [
          {
            path: 'llm-pi-ai.providers.openai.models',
            label: 'models',
            type: 'array',
            required: false,
            restartRequired: false,
          },
        ],
        namespaces: [{ ns: 'llm-pi-ai', applies: 'live', revision: 3, userFields: [], secrets: [] }],
      },
      values: {
        'llm-pi-ai': {
          providers: {
            openai: {
              defaultInput: ['text', 'image'],
              models: [{ id: 'vision-model', input: [] }],
            },
          },
        },
      },
    }
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <I18nProvider>
        <ProviderSettingsEditor
          provider={piProvider}
          settings={settings}
          writable
          saving={false}
          onSave={onSave as (changes: readonly ProviderSettingChange[]) => Promise<void>}
          onDiscover={vi.fn().mockResolvedValue([])}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    )

    expandAdvanced()
    expect(screen.getByText('Inherited: Text, Image')).toBeDefined()
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Image' }).checked).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Image' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith([
        {
          kind: 'set',
          path: 'llm-pi-ai.providers.openai.models',
          value: [{ id: 'vision-model', input: ['text'] }],
        },
      ], 3),
    )
  })
})
