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
    previewId: 'dsh-preview-test-1',
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
    await waitFor(() =>
      expect(props.onRestore).toHaveBeenCalledWith('dsh-checkpoint-1', 'dsh-preview-test-1', 'overwrite'),
    )
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
})
