// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CheckpointPreview, CheckpointSummary } from '@dsh-vscode/domain'

import { CheckpointDrawer } from './CheckpointDrawer.js'

function checkpoint(overrides: Partial<CheckpointSummary> = {}): CheckpointSummary {
  return {
    checkpointId: 'dsh-checkpoint-1',
    sessionId: 'session-1',
    workspaceFolderId: 'workspace-1',
    createdAt: 1_000,
    label: 'Before refactor',
    fileCount: 1,
    totalBytes: 3,
    state: 'content-ready',
    restoreAllowed: true,
    contentEnabled: true,
    expectedRevision: 1,
    ...overrides,
  }
}

function preview(summary: CheckpointSummary, conflict = false): CheckpointPreview {
  return {
    summary,
    files: [
      {
        relativePath: 'src/main.ts',
        presentAtCheckpoint: true,
        expectedCurrentHash: 'a'.repeat(64),
        currentHash: conflict ? 'b'.repeat(64) : 'a'.repeat(64),
        conflict,
        byteSize: 3,
      },
    ],
    conflictCount: conflict ? 1 : 0,
  }
}

function renderDrawer(
  overrides: Partial<React.ComponentProps<typeof CheckpointDrawer>> = {},
): React.ComponentProps<typeof CheckpointDrawer> {
  const current = checkpoint()
  const props: React.ComponentProps<typeof CheckpointDrawer> = {
    checkpoints: [current],
    loading: false,
    onRefresh: vi.fn().mockResolvedValue(undefined),
    onCreate: vi.fn().mockResolvedValue(current),
    onPreview: vi.fn().mockResolvedValue(preview(current)),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onRestore: vi.fn().mockResolvedValue('completed'),
    ...overrides,
  }
  render(<CheckpointDrawer {...props} />)
  fireEvent.click(screen.getByRole('button', { name: `${props.checkpoints.length} checkpoints` }))
  return props
}

describe('CheckpointDrawer', () => {
  afterEach(() => cleanup())

  it('offers explicit creation and passes only the user-entered label', async () => {
    const onCreate = vi.fn().mockResolvedValue(checkpoint())
    renderDrawer({ checkpoints: [], onCreate })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: '  Before tests  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create checkpoint' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Before tests'))
  })

  it('previews files and hashes before allowing a clean restore', async () => {
    const props = renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Restore Before refactor' }))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeDefined())
    expect(screen.getByText('src/main.ts')).toBeDefined()
    expect(screen.getByText('aaaaaaaaaaaa')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Restore files' }))
    // Nothing drifted from the checkpoint, so the safe policy stays on: a file
    // that changes between this preview and the restore must not be clobbered.
    await waitFor(() => expect(props.onRestore).toHaveBeenCalledWith('dsh-checkpoint-1', 'abort'))
  })

  it('restores a drifted file once the user confirms the preview that lists it', async () => {
    const props = renderDrawer({ onPreview: vi.fn().mockResolvedValue(preview(checkpoint(), true)) })
    fireEvent.click(screen.getByRole('button', { name: 'Restore Before refactor' }))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeDefined())

    // The dialog states what the restore does with the drifted file, and the
    // confirmation is what accepts the overwrite: before this, the button was
    // disabled for every drifted file, so the restore could never do its job.
    expect(screen.getByText('1 file(s) differ from the checkpoint and are replaced.')).toBeDefined()
    expect(screen.getByText('changed')).toBeDefined()
    const confirm = screen.getByRole('button', { name: 'Restore files' })
    expect(confirm).toHaveProperty('disabled', false)

    fireEvent.click(confirm)
    await waitFor(() => expect(props.onRestore).toHaveBeenCalledWith('dsh-checkpoint-1', 'overwrite'))
  })

  it('marks a file the checkpoint never stored as added since', async () => {
    const current = checkpoint()
    const later: CheckpointPreview = {
      summary: current,
      files: [
        {
          relativePath: 'src/later.ts',
          presentAtCheckpoint: false,
          currentHash: 'c'.repeat(64),
          conflict: true,
          byteSize: 0,
        },
      ],
      conflictCount: 1,
    }
    renderDrawer({ onPreview: vi.fn().mockResolvedValue(later) })
    fireEvent.click(screen.getByRole('button', { name: 'Restore Before refactor' }))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeDefined())

    // The checkpoint holds no content for it, so the restore removes it instead
    // of replacing it — the row cannot say "changed".
    expect(screen.getByText('added since')).toBeDefined()
  })

  it('reports partial restoration without claiming completion', async () => {
    renderDrawer({ onRestore: vi.fn().mockResolvedValue('partial') })
    fireEvent.click(screen.getByRole('button', { name: 'Restore Before refactor' }))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeDefined())
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Restore files' }))
    await waitFor(() => expect(screen.getByText(/Checkpoint only partially restored/u)).toBeDefined())
    expect(screen.queryByText('Checkpoint restored.')).toBeNull()
  })

  it('requires a separate confirmation before deletion', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onDelete })
    fireEvent.click(screen.getByRole('button', { name: 'Delete Before refactor' }))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete checkpoint' }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('dsh-checkpoint-1'))
  })

  it('gives the keyboard back to the Create button after the label dialog closes', () => {
    renderDrawer({ checkpoints: [] })

    const trigger = screen.getByRole('button', { name: 'Create' })
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getByLabelText('Label')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByLabelText('Label')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('takes focus into the restore confirmation and gives it back to the row', async () => {
    renderDrawer()

    const trigger = screen.getByRole('button', { name: 'Restore Before refactor' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.contains(document.activeElement)).toBe(true)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('takes focus into the delete confirmation and gives it back to the row', () => {
    renderDrawer()

    const trigger = screen.getByRole('button', { name: 'Delete Before refactor' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('alertdialog')
    expect(dialog.contains(document.activeElement)).toBe(true)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('dismisses the popover when the pointer goes elsewhere', () => {
    renderDrawer()
    expect(screen.getByRole('dialog', { name: 'Session checkpoints' })).toBeDefined()

    fireEvent.pointerDown(document.body)

    expect(screen.queryByRole('dialog', { name: 'Session checkpoints' })).toBeNull()
  })

  it('closes the popover when its own trigger is pressed again', () => {
    renderDrawer()
    const trigger = screen.getByRole('button', { name: '1 checkpoints' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)

    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps an open confirmation while the pointer goes elsewhere', () => {
    renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Before refactor' }))
    expect(screen.getByRole('alertdialog')).toBeDefined()

    fireEvent.pointerDown(document.body)

    // The confirmation is `aria-modal`: an accidental press elsewhere must not
    // discard it, and the popover underneath has to survive with it.
    expect(screen.getByRole('alertdialog')).toBeDefined()
    expect(screen.getByRole('dialog', { name: 'Session checkpoints' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.pointerDown(document.body)

    expect(screen.queryByRole('dialog', { name: 'Session checkpoints' })).toBeNull()
  })
})
