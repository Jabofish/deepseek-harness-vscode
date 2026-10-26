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
})
