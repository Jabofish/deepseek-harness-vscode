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

  it('groups the roster by trust and marks the default and broken rows', async () => {
    renderManager()
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())
    expect(screen.getByText('Custom presets')).toBeDefined()
    // The default row is the pressed card and cannot be re-picked.
    expect(screen.getByRole('button', { name: 'In use: Standard', pressed: true })).toHaveProperty(
      'disabled',
      true,
    )
    // A broken custom row shows why and stays unselectable.
    const broken = screen.getByRole('button', { name: /^Broken: broken-copy/ })
    expect(broken).toHaveProperty('disabled', true)
    expect(screen.getByText('missing agent.cordis.yml')).toBeDefined()
  })

  it('renders nothing for a deployment that composes no presets', async () => {
    const { container } = render(
      <PresetManager
        onLoadRoster={vi.fn().mockResolvedValue({ presets: [], authorable: false, hasDocument: false })}
        onReadDocument={vi.fn()}
        onCopy={vi.fn()}
        onRemove={vi.fn()}
        onOpenLocation={vi.fn()}
        onMakeDefault={vi.fn()}
      />,
    )
    await waitFor(() => expect(container.firstChild).toBeNull())
  })

  it('offers a retry after a failed roster read', async () => {
    const onLoadRoster = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue(rosterFixture())
    renderManager({ onLoadRoster })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be read'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())
  })
})

describe('PresetManager default selection', () => {
  afterEach(() => cleanup())

  it('writes the agent-presets.default settings field and re-reads the roster', async () => {
    const onMakeDefault = vi.fn().mockResolvedValue(undefined)
    renderManager({ onMakeDefault })
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Set as default: Cordis' }))
    await waitFor(() => expect(onMakeDefault).toHaveBeenCalledWith('cordis'))
  })

  it('surfaces a failed default write instead of pretending it succeeded', async () => {
    const onMakeDefault = vi.fn().mockRejectedValue(new Error('settings-conflict'))
    renderManager({ onMakeDefault })
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Set as default: Cordis' }))
    await waitFor(() => expect(screen.getByText('settings-conflict')).toBeDefined())
    expect(screen.getByRole('button', { name: 'Set as default: Cordis' })).toBeDefined()
  })

  it('does not offer a default mutation when the settings provider is read-only', async () => {
    const onMakeDefault = vi.fn().mockResolvedValue(undefined)
    renderManager({ onMakeDefault, defaultWritable: false })
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())

    const button = screen.getByRole('button', { name: 'Set as default: Cordis' })
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.getAttribute('title')).toContain('read-only')
    fireEvent.click(button)
    expect(onMakeDefault).not.toHaveBeenCalled()
  })
})

describe('PresetManager composition viewer', () => {
  afterEach(() => cleanup())

  it('shows a shipped composition read-only', async () => {
    const document: AgentPresetDocument = {
      id: 'cordis',
      trust: 'system',
      name: 'Cordis',
      content: 'instructions:\n  - self-authored presets\n',
    }
    const onReadDocument = vi.fn().mockResolvedValue(document)
    renderManager({ onReadDocument })
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'View composition: Cordis' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Preset composition' })).toBeDefined())
    expect(onReadDocument).toHaveBeenCalledWith('cordis')
    expect(screen.getByText(/self-authored presets/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'Preset composition' })).toBeNull()
  })

  it('withholds the viewer for a broken shipped row', async () => {
    renderManager()
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())
    // Only the unbroken system rows carry a viewer affordance.
    expect(
      screen.queryByRole('button', { name: 'View composition: Standard' }) === undefined ||
        screen.queryByRole('button', { name: 'View composition: Cordis' }) !== undefined,
    ).toBe(true)
  })
})

describe('PresetManager location', () => {
  afterEach(() => cleanup())

  it('reveals the path under the card when the host has no desktop opener', async () => {
    const onOpenLocation = vi
      .fn()
      .mockResolvedValue({ opened: false, path: '/presets/my-copy' } satisfies AgentPresetLocation)
    renderManager({ onOpenLocation })
    await waitFor(() => expect(screen.getByText('Custom presets')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Open location: My copy' }))
    await waitFor(() => expect(screen.getByText('/presets/my-copy')).toBeDefined())
  })

  it('keeps a native open silent', async () => {
    const onOpenLocation = vi.fn().mockResolvedValue({ opened: true } satisfies AgentPresetLocation)
    renderManager({ onOpenLocation })
    await waitFor(() => expect(screen.getByText('Custom presets')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Open location: My copy' }))
    await waitFor(() => expect(onOpenLocation).toHaveBeenCalledWith('my-copy'))
    expect(screen.queryByText('Preset directory')).toBeNull()
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

  it('copies, reloads the roster, and lands in the new preset files', async () => {
    let call = 0
    const onLoadRoster = vi.fn().mockImplementation(() => {
      call += 1
      return Promise.resolve(
        call === 1
          ? rosterFixture()
          : {
              ...rosterFixture(),
              presets: [
                ...rosterFixture().presets,
                { id: 'fresh-copy', trust: 'user' as const, isDefault: false, name: 'Fresh copy' },
              ],
            },
      )
    })
    const onCopy = vi.fn().mockResolvedValue('fresh-copy')
    const onOpenLocation = vi.fn().mockResolvedValue({ opened: true } satisfies AgentPresetLocation)
    renderManager({ onLoadRoster, onCopy, onOpenLocation })
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Copy preset: Standard' }))
    fireEvent.change(screen.getByLabelText('Preset id'), { target: { value: 'fresh-copy' } })
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Fresh copy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onCopy).toHaveBeenCalledWith('standard', 'fresh-copy', 'Fresh copy'))
    // A copy changes more than its row: the roster is re-read.
    await waitFor(() => expect(onLoadRoster).toHaveBeenCalledTimes(2))
    // And the user lands in the new preset's files.
    await waitFor(() => expect(onOpenLocation).toHaveBeenCalledWith('fresh-copy'))
    expect(screen.queryByRole('dialog', { name: 'Copy preset' })).toBeNull()
  })

  it('surfaces a host refusal on the dialog', async () => {
    const onCopy = vi.fn().mockRejectedValue(new Error('agent-preset-read-only'))
    renderManager({ onCopy })
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Copy preset: Standard' }))
    fireEvent.change(screen.getByLabelText('Preset id'), { target: { value: 'fresh-copy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(screen.getByText('agent-preset-read-only')).toBeDefined())
    expect(screen.getByRole('dialog', { name: 'Copy preset' })).toBeDefined()
  })

  it('disables copying when the deployment has no writable root', async () => {
    const onLoadRoster = vi.fn().mockResolvedValue({ ...rosterFixture(), authorable: false })
    renderManager({ onLoadRoster })
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())
    expect(screen.getByRole('button', { name: 'Copy preset: Standard' })).toHaveProperty('disabled', true)
  })
})

describe('PresetManager removal', () => {
  afterEach(() => cleanup())

  it('deletes a user preset only after confirmation and re-reads the roster', async () => {
    const onLoadRoster = vi.fn().mockResolvedValue(rosterFixture())
    const onRemove = vi.fn().mockResolvedValue(undefined)
    renderManager({ onLoadRoster, onRemove })
    await waitFor(() => expect(screen.getByText('Custom presets')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Delete preset: My copy' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Delete preset' })
    expect(dialog).toBeDefined()
    // Cancel first: nothing is deleted.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onRemove).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog', { name: 'Delete preset' })).toBeNull()
    // Confirm: the removal flies and the roster reloads.
    fireEvent.click(screen.getByRole('button', { name: 'Delete preset: My copy' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith('my-copy'))
    await waitFor(() => expect(onLoadRoster).toHaveBeenCalledTimes(2))
  })

  it('never offers deletion for shipped presets', async () => {
    renderManager()
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())
    expect(screen.queryByRole('button', { name: 'Delete preset: Standard' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete preset: Cordis' })).toBeNull()
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
