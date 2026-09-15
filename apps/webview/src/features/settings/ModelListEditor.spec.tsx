// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
})
