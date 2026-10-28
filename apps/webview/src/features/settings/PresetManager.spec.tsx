// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentPresetDocument, AgentPresetLocation, AgentPresetRoster } from '@dsh-vscode/domain'
import { PresetManager } from './PresetManager.js'

function rosterFixture(): AgentPresetRoster {
  return {
    presets: [
      {
        id: 'standard',
        trust: 'system',
        isDefault: true,
        name: 'Standard',
        description: 'The default composition.',
      },
      { id: 'cordis', trust: 'system', isDefault: false, name: 'Cordis' },
      { id: 'ptc', trust: 'system', isDefault: false, name: 'PTC' },
      { id: 'minimal', trust: 'system', isDefault: false, name: 'Minimal' },
      {
        id: 'my-copy',
        trust: 'user',
        isDefault: false,
        name: 'My copy',
        description: 'A local composition.',
      },
      {
        id: 'broken-copy',
        trust: 'user',
        isDefault: false,
        broken: 'missing agent.cordis.yml',
      },
    ],
    authorable: true,
    hasDocument: true,
    canOpenPresetLocation: true,
    canRemoveUserPresets: true,
  }
}

function renderManager(
  overrides: Partial<Parameters<typeof PresetManager>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <PresetManager
      onLoadRoster={vi.fn().mockResolvedValue(rosterFixture())}
      onReadDocument={vi.fn().mockResolvedValue(undefined)}
      onCopy={vi.fn().mockResolvedValue(undefined)}
      onRemove={vi.fn().mockResolvedValue(undefined)}
      onOpenLocation={vi.fn().mockResolvedValue({ opened: true } satisfies AgentPresetLocation)}
      onMakeDefault={vi.fn().mockResolvedValue(undefined)}
      {...overrides}
    />,
  )
}

describe('PresetManager roster', () => {
  afterEach(() => cleanup())

  it('hides unsupported RC2 user-preset management actions but keeps selection and composition reads', async () => {
    const onMakeDefault = vi.fn().mockResolvedValue(undefined)
    const onReadDocument = vi.fn().mockResolvedValue({
      id: 'my-copy',
      trust: 'user',
      content: 'plugins:\n  - tool-fs\n',
    } satisfies AgentPresetDocument)
    const onOpenLocation = vi.fn()
    const onRemove = vi.fn()
    const onCopy = vi.fn()
    renderManager({
      onLoadRoster: vi.fn().mockResolvedValue({
        ...rosterFixture(),
        authorable: false,
        canOpenPresetLocation: false,
        canRemoveUserPresets: false,
        compositionReadable: true,
        defaultSettingPath: 'agent-preset-registry.selectedDefault',
      }),
      onMakeDefault,
      onReadDocument,
      onOpenLocation,
      onRemove,
      onCopy,
    })

    const select = await screen.findByRole('button', { name: 'Set as default: My copy' })
    expect(select.hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Open location: My copy' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete preset: My copy' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy preset: My copy' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy preset: Standard' })).toBeNull()

    fireEvent.click(select)
    await waitFor(() =>
      expect(onMakeDefault).toHaveBeenCalledWith('my-copy', 'agent-preset-registry.selectedDefault'),
    )
    fireEvent.click(screen.getByRole('button', { name: 'View composition: My copy' }))
    await screen.findByRole('dialog', { name: 'Preset composition' })

    expect(onReadDocument).toHaveBeenCalledWith('my-copy')
    expect(onOpenLocation).not.toHaveBeenCalled()
    expect(onRemove).not.toHaveBeenCalled()
    expect(onCopy).not.toHaveBeenCalled()
  })
})

describe('PresetManager copy dialog', () => {
  afterEach(() => cleanup())

  it('blocks an invalid or taken id client-side and never sends it', async () => {
    const onCopy = vi.fn().mockResolvedValue('fresh-copy')
    renderManager({ onCopy })
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Copy preset: Standard' }))
    const dialog = screen.getByRole('dialog', { name: 'Copy preset' })
    expect(dialog).toBeDefined()
    // Empty id: create stays disabled.
    expect(screen.getByRole('button', { name: 'Create' })).toHaveProperty('disabled', true)
    // Invalid characters.
    fireEvent.change(screen.getByLabelText('Preset id'), { target: { value: 'My Copy!' } })
    expect(within(dialog).getByRole('alert').textContent).toContain('lowercase letters, digits, and dashes')
    expect(screen.getByRole('button', { name: 'Create' })).toHaveProperty('disabled', true)
    // An id already on the roster.
    fireEvent.change(screen.getByLabelText('Preset id'), { target: { value: 'cordis' } })
    expect(within(dialog).getByRole('alert').textContent).toContain('already exists')
    expect(onCopy).not.toHaveBeenCalled()
  })
})

describe('PresetManager removal', () => {
  afterEach(() => cleanup())

  it('deletes a user preset only after confirmation and re-reads the roster', async () => {
    const onLoadRoster = vi.fn().mockResolvedValue(rosterFixture())
    const onRemove = vi.fn().mockResolvedValue(undefined)
    renderManager({ onLoadRoster, onRemove })
    await waitFor(() => expect(screen.getByText('Custom presets')).toBeDefined())
    expect(screen.queryByRole('button', { name: 'Delete preset: Standard' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete preset: Cordis' })).toBeNull()
    const trigger = screen.getByRole('button', { name: 'Delete preset: My copy' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('alertdialog', { name: 'Delete preset' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    // Cancel first: nothing is deleted.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onRemove).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog', { name: 'Delete preset' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
    // Confirm: the removal flies and the roster reloads.
    fireEvent.click(screen.getByRole('button', { name: 'Delete preset: My copy' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith('my-copy'))
    await waitFor(() => expect(onLoadRoster).toHaveBeenCalledTimes(2))
  })

  it('keeps the confirmation open and reports a failed removal', async () => {
    const onRemove = vi.fn().mockRejectedValue(new Error('agent-preset-conflict'))
    renderManager({ onRemove })
    await waitFor(() => expect(screen.getByText('Custom presets')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Delete preset: My copy' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.getByText('agent-preset-conflict')).toBeDefined())
    expect(screen.getByRole('alertdialog', { name: 'Delete preset' })).toBeDefined()
  })
})
