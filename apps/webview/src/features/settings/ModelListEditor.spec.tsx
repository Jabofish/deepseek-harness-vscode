// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelDescriptor } from '@dsh-vscode/domain'

import { ModelListEditor } from './ModelListEditor.js'

/** The dismissal listeners register in a passive effect; let them flush so a
 * press cannot race the registration. */
async function flushPendingEffects(): Promise<void> {
  await act(() => Promise.resolve())
}

function renderEditor(onDiscover = vi.fn().mockResolvedValue([{ id: 'model-new' }])): void {
  render(
    <ModelListEditor
      models={[]}
      writable
      saving={false}
      discoveryInput={{ settingsNamespace: 'llm-deepseek', providerId: 'deepseek' }}
      onSave={vi.fn().mockResolvedValue(undefined)}
      onDiscover={onDiscover}
    />,
  )
}

describe('ModelListEditor state notifications', () => {
  afterEach(() => cleanup())

  it('does not notify the parent during render and reports edits from the event handler', () => {
    const onChange = vi.fn()
    render(
      <ModelListEditor
        models={[{ id: 'model-a' }]}
        writable
        saving={false}
        discoveryInput={{ settingsNamespace: 'llm-deepseek', providerId: 'deepseek' }}
        onChange={onChange}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onDiscover={vi.fn().mockResolvedValue([])}
      />,
    )

    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'model-b' } })

    expect(onChange).toHaveBeenCalledWith([{ id: 'model-b' }])
  })

  it('closes the discovered-models dialog on Escape', async () => {
    renderEditor()

    fireEvent.click(screen.getByRole('button', { name: 'Get available models' }))
    await screen.findByRole('dialog', { name: 'Available models' })
    await flushPendingEffects()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Available models' })).toBeNull()
  })

  it('keeps the discovered-models dialog when the Escape is consumed inside it', async () => {
    renderEditor()

    fireEvent.click(screen.getByRole('button', { name: 'Get available models' }))
    const dialog = await screen.findByRole('dialog', { name: 'Available models' })
    await flushPendingEffects()
    dialog.addEventListener('keydown', (event) => event.preventDefault())

    fireEvent.keyDown(dialog, { key: 'Escape' })

    expect(screen.getByRole('dialog', { name: 'Available models' })).toBeDefined()
  })

  it('takes focus into the discovered-models dialog and gives it back to the trigger', async () => {
    // The dialog is `aria-modal`, so the keyboard must not stay on the trigger
    // behind it; closing returns focus to the button that opened it.
    renderEditor()
    const trigger = screen.getByRole('button', { name: 'Get available models' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Available models' })

    expect(dialog.contains(document.activeElement)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog', { name: 'Available models' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

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

  it('does not let the user clear the last explicitly selected input type', () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <ModelListEditor
        models={[{ id: 'text-model', inputModalities: ['text'] }]}
        writable
        saving={false}
        discoveryInput={{ settingsNamespace: 'llm-deepseek', providerId: 'deepseek' }}
        onSave={onSave}
        onDiscover={vi.fn().mockResolvedValue([])}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Advanced model settings' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Text' }))

    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Text' }).checked).toBe(true)
    expect(screen.getByRole('alert').textContent).toBe('Select at least one input type.')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('copies disclosed discovery modalities into the provider-specific setting field', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onDiscover = vi
      .fn()
      .mockResolvedValue([{ id: 'vision-model', label: 'Vision model', inputModalities: ['text', 'image'] }])
    render(
      <ModelListEditor
        models={[]}
        inputField="input"
        writable
        saving={false}
        discoveryInput={{ settingsNamespace: 'llm-pi-ai', providerId: 'openai' }}
        onSave={onSave}
        onDiscover={onDiscover}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Get available models' }))
    const dialog = await screen.findByRole('dialog', { name: 'Available models' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add selected' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save model list' }))

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith([
        { id: 'vision-model', name: 'Vision model', input: ['text', 'image'] },
      ]),
    )
  })
})
