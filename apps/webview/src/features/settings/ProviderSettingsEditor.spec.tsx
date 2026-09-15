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

function snapshot(models: readonly unknown[]): DshSettingsSnapshot {
  return {
    schema: {
      version: 'rc6-settings-v2',
      writable: true,
      hasDocument: false,
      fields: [
        {
          path: 'llm-deepseek.models',
          label: 'models',
          type: 'array',
          required: false,
          restartRequired: false,
        },
      ],
      namespaces: [{ ns: 'llm-deepseek', applies: 'live', revision: 3, userFields: [], secrets: [] }],
    },
    values: { 'llm-deepseek': { models } },
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
  afterEach(() => cleanup())

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
})
