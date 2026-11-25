// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelDescriptor } from '@dsh-vscode/domain'

import { ModelListEditor } from './ModelListEditor.js'

/** The dismissal listeners register in a passive effect; let them flush so a
 * press cannot race the registration. */

describe('ModelListEditor state notifications', () => {
  afterEach(() => cleanup())

  it('persists explicit input types and removes DeepSeek image budgets when Image is disabled', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <ModelListEditor
        models={[
          {
            id: 'vision-model',
            inputModalities: ['text', 'image'],
            imagePixelBudget: 1_000_000,
            imageMaxBytes: 8_000_000,
          },
        ]}
        writable
        saving={false}
        discoveryInput={{ settingsNamespace: 'llm-deepseek', providerId: 'deepseek' }}
        onSave={onSave}
        onDiscover={vi.fn().mockResolvedValue([])}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Advanced model settings' }))
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Image' }).checked).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Image' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save model list' }))

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith([{ id: 'vision-model', inputModalities: ['text'] }]),
    )
  })

  it('restores inherited catalog inputs instead of persisting the effective value', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const catalogModels: readonly ModelDescriptor[] = [
      {
        id: 'vision-model',
        providerId: 'deepseek',
        label: 'Vision model',
        inputModalities: ['text', 'image'],
        supportsReasoning: false,
      },
    ]
    render(
      <ModelListEditor
        models={[{ id: 'vision-model', inputModalities: ['text'] }]}
        catalogModels={catalogModels}
        providerDefaultInput={['text']}
        writable
        saving={false}
        discoveryInput={{ settingsNamespace: 'llm-deepseek', providerId: 'deepseek' }}
        onSave={onSave}
        onDiscover={vi.fn().mockResolvedValue([])}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Advanced model settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use inherited' }))

    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Image' }).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save model list' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith([{ id: 'vision-model' }]))
  })

  it('keeps the model ID input mounted and focused across keystrokes', () => {
    render(
      <ModelListEditor
        models={[{ id: '' }]}
        writable
        saving={false}
        discoveryInput={{ settingsNamespace: 'llm-deepseek', providerId: 'deepseek' }}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onDiscover={vi.fn().mockResolvedValue([])}
      />,
    )

    const input = screen.getByLabelText<HTMLInputElement>('Model ID')
    input.focus()
    expect(document.activeElement).toBe(input)

    fireEvent.change(input, { target: { value: 'd' } })
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'deepseek-chat' } })
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('deepseek-chat')
  })

  it('starts discovery with nothing picked, filters the list and skips models already added', async () => {
    const onChange = vi.fn()
    render(
      <ModelListEditor
        models={[{ id: 'deepseek-chat' }]}
        writable
        saving={false}
        showSave={false}
        discoveryInput={{ settingsNamespace: 'llm-deepseek', providerId: 'deepseek' }}
        onChange={onChange}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onDiscover={vi.fn().mockResolvedValue([
          { id: 'deepseek-chat', label: 'deepseek-chat' },
          { id: 'deepseek-reasoner', label: 'deepseek-reasoner' },
          { id: 'qwen-max', label: 'Qwen Max' },
        ])}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Get available models' }))
    const dialog = await screen.findByRole('dialog', { name: 'Available models' })
    expect(dialog).toBeDefined()
    expect(screen.getByRole('button', { name: 'Add selected (0)' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /deepseek-chat/u }).disabled).toBe(true)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter models' }), { target: { value: 'qwen' } })
    expect(screen.queryByRole('checkbox', { name: /deepseek-reasoner/u })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add selected (1)' }))
    expect(onChange).toHaveBeenLastCalledWith([{ id: 'deepseek-chat' }, { id: 'qwen-max', name: 'Qwen Max' }])
  })
})
