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
      codingToolsEnabled={true}
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

  it('localizes rc.2 built-in modes when the Remote roster omits names and descriptions', async () => {
    renderManager({
      onLoadRoster: vi.fn().mockResolvedValue({
        authorable: false,
        compositionReadable: true,
        defaultSettingPath: 'agent-preset-registry.selectedDefault',
        presets: [
          { id: 'standard', trust: 'system', isDefault: true },
          { id: 'ptc', trust: 'system', isDefault: false },
          { id: 'minimal', trust: 'system', isDefault: false },
          { id: 'cordis', trust: 'system', isDefault: false },
        ],
      } satisfies AgentPresetRoster),
    })

    await waitFor(() => expect(screen.getByRole('button', { name: 'In use: Standard' })).toBeDefined())
    expect(screen.getByRole('button', { name: 'Set as default: PTC' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Set as default: Minimal' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Set as default: Creator' })).toBeDefined()
    expect(
      screen.getByText('For most code, file, and research tasks. Agent uses tools as needed.'),
    ).toBeDefined()
    expect(screen.queryByText('No description')).toBeNull()
  })

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

  it('guides an empty read-only RC2 custom group to Creator bundle management', async () => {
    const onStartCreatorDraft = vi.fn().mockResolvedValue(undefined)
    renderManager({
      onLoadRoster: vi.fn().mockResolvedValue({
        presets: [
          { id: 'standard', trust: 'system', isDefault: true },
          { id: 'cordis', trust: 'system', isDefault: false },
        ],
        authorable: false,
        canOpenPresetLocation: false,
        canRemoveUserPresets: false,
        compositionReadable: true,
      }),
      onStartCreatorDraft,
    })

    const creator = await screen.findByRole('button', { name: 'Ask Agent to create a mode' })
    expect(
      screen.getByText(/Creator mode to build and install a bundle that declares one.*DSH loads it/),
    ).toBeDefined()
    expect(screen.queryByText(/Copy a built-in preset/)).toBeNull()

    fireEvent.click(creator)
    await waitFor(() => expect(onStartCreatorDraft).toHaveBeenCalledOnce())
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

  it('does not offer an ineffective default mutation when mode selection is hidden', async () => {
    const onMakeDefault = vi.fn().mockResolvedValue(undefined)
    renderManager({
      onMakeDefault,
      onLoadRoster: vi.fn().mockResolvedValue({
        ...rosterFixture(),
        modeSelectionEnabled: false,
      }),
    })
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())

    const button = screen.getByRole('button', { name: 'Set as default: Cordis' })
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.getAttribute('title')).toContain('selection is hidden')
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

  it('offers the read-only viewer for custom and broken declarations', async () => {
    const onReadDocument = vi.fn().mockImplementation((id: string) =>
      Promise.resolve({
        id,
        trust: id === 'broken-system' ? 'system' : 'user',
        content: `plugins:\n  - ${id}\n`,
      } satisfies AgentPresetDocument),
    )
    renderManager({
      onReadDocument,
      onLoadRoster: vi.fn().mockResolvedValue({
        ...rosterFixture(),
        compositionReadable: true,
        presets: [
          ...rosterFixture().presets,
          { id: 'broken-system', trust: 'system', isDefault: false, broken: 'invalid composition' },
        ],
      }),
    })
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'View composition: My copy' }))
    await screen.findByRole('dialog', { name: 'Preset composition' })
    expect(onReadDocument).toHaveBeenCalledWith('my-copy')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    fireEvent.click(screen.getByRole('button', { name: 'View composition: broken-system' }))
    await screen.findByRole('dialog', { name: 'Preset composition' })
    expect(onReadDocument).toHaveBeenCalledWith('broken-system')
  })

  it('opens localized mode explanations and use guidance without changing the default', async () => {
    const onMakeDefault = vi.fn()
    renderManager({ onMakeDefault })
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())
    const trigger = screen.getByRole('button', { name: 'Mode details: Standard' })
    fireEvent.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: 'Standard · guide' })
    expect(within(dialog).getByText(/Choose Standard mode/)).toBeDefined()
    fireEvent.click(within(dialog).getByRole('button', { name: 'How to use' }))
    expect(within(dialog).getByText(/search form loses results/)).toBeDefined()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))

    expect(screen.queryByRole('dialog', { name: 'Standard · guide' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(onMakeDefault).not.toHaveBeenCalled()
  })

  it('keeps guide keyboard focus inside and restores it after Escape', async () => {
    renderManager()
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())
    const trigger = screen.getByRole('button', { name: 'Mode details: Standard' })
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Standard · guide' })
    const close = within(dialog).getByRole('button', { name: 'Close' })
    const first = within(dialog).getByRole('button', { name: 'Mode details' })

    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(dialog, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Standard · guide' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes the composition viewer on Escape', async () => {
    const onReadDocument = vi.fn().mockResolvedValue({
      id: 'cordis',
      trust: 'system',
      name: 'Cordis',
      content: 'instructions:\n  - self-authored presets\n',
    } satisfies AgentPresetDocument)
    renderManager({ onReadDocument })
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'View composition: Cordis' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Preset composition' })).toBeDefined())

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Preset composition' })).toBeNull()
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

  it('does not render copy actions when the deployment has no writable root', async () => {
    const onLoadRoster = vi.fn().mockResolvedValue({ ...rosterFixture(), authorable: false })
    renderManager({ onLoadRoster })
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())
    expect(screen.queryByRole('button', { name: 'Copy preset: Standard' })).toBeNull()
  })

  it('closes the copy dialog on Escape without sending anything', async () => {
    const onCopy = vi.fn().mockResolvedValue('fresh-copy')
    renderManager({ onCopy })
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Copy preset: Standard' }))
    fireEvent.change(screen.getByLabelText('Preset id'), { target: { value: 'fresh-copy' } })

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Copy preset' })).toBeNull()
    expect(onCopy).not.toHaveBeenCalled()
  })

  it('keeps the copy dialog open while the copy is in flight', async () => {
    const onCopy = vi.fn().mockReturnValue(new Promise(() => undefined))
    renderManager({ onCopy })
    await waitFor(() => expect(screen.getByText('Built-in presets')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Copy preset: Standard' }))
    fireEvent.change(screen.getByLabelText('Preset id'), { target: { value: 'fresh-copy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.getByRole('dialog', { name: 'Copy preset' })).toBeDefined()
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

  it('cancels the delete confirmation on Escape', async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined)
    renderManager({ onRemove })
    await waitFor(() => expect(screen.getByText('Custom presets')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Delete preset: My copy' }))

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('alertdialog', { name: 'Delete preset' })).toBeNull()
    expect(onRemove).not.toHaveBeenCalled()
  })

  it('takes focus into the delete confirmation and gives it back to the row', async () => {
    // Every preset modal is portalled and `aria-modal`; leaving the keyboard on
    // the row behind it walks the pointer-less user into the obscured roster.
    renderManager()
    await waitFor(() => expect(screen.getByText('Custom presets')).toBeDefined())
    const trigger = screen.getByRole('button', { name: 'Delete preset: My copy' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('alertdialog', { name: 'Delete preset' })

    expect(dialog.contains(document.activeElement)).toBe(true)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog', { name: 'Delete preset' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('registry-only preset policy', () => {
  afterEach(() => cleanup())
  it('withholds absent composition reads and chooser-policy default writes', async () => {
    const read = vi.fn()
    const makeDefault = vi.fn()
    renderManager({
      onLoadRoster: () =>
        Promise.resolve({
          ...rosterFixture(),
          authorable: false,
          compositionReadable: false,
          modeSelectionEnabled: false,
        }),
      onReadDocument: read,
      onMakeDefault: makeDefault,
    })
    await screen.findByRole('button', { name: 'In use: Standard' })
    expect(screen.queryByRole('button', { name: 'View composition: Standard' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Set as default: Cordis' }))
    expect(read).not.toHaveBeenCalled()
    expect(makeDefault).not.toHaveBeenCalled()
  })
  it('passes the adapter default field through the existing settings write', async () => {
    const makeDefault = vi.fn().mockResolvedValue(undefined)
    renderManager({
      onLoadRoster: () =>
        Promise.resolve({
          ...rosterFixture(),
          defaultSettingPath: 'agent-preset-registry.selectedDefault',
        }),
      onMakeDefault: makeDefault,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Set as default: Cordis' }))
    await waitFor(() =>
      expect(makeDefault).toHaveBeenCalledWith('cordis', 'agent-preset-registry.selectedDefault'),
    )
  })

  it('starts the Creator task when DSH does not expose a writable preset directory', async () => {
    const onStartCreatorDraft = vi.fn().mockResolvedValue(undefined)
    renderManager({
      onLoadRoster: vi.fn().mockResolvedValue({
        ...rosterFixture(),
        authorable: false,
        compositionReadable: true,
      }),
      onStartCreatorDraft,
      codingToolsEnabled: true,
    })
    const button = await screen.findByRole('button', { name: 'Ask Agent to create a mode' })
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(onStartCreatorDraft).toHaveBeenCalledOnce())
  })

  it('gates the Creator entry when rc.2 Developer Tools are disabled', async () => {
    const onStartCreatorDraft = vi.fn()
    renderManager({ onStartCreatorDraft, codingToolsEnabled: false })
    const button = await screen.findByRole('button', { name: 'Ask Agent to create a mode' })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
    expect(onStartCreatorDraft).not.toHaveBeenCalled()
  })

  it('keeps preset selection and Creator closed while Developer Tools are unresolved', async () => {
    const onMakeDefault = vi.fn().mockResolvedValue(undefined)
    const onStartCreatorDraft = vi.fn()
    renderManager({ onMakeDefault, onStartCreatorDraft, codingToolsEnabled: undefined })

    const mode = await screen.findByRole('button', { name: 'Set as default: Cordis' })
    const creator = screen.getByRole('button', { name: 'Ask Agent to create a mode' })
    expect(mode).toHaveProperty('disabled', true)
    expect(creator).toHaveProperty('disabled', true)
    fireEvent.click(mode)
    fireEvent.click(creator)
    expect(onMakeDefault).not.toHaveBeenCalled()
    expect(onStartCreatorDraft).not.toHaveBeenCalled()
  })
})
