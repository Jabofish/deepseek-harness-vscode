// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    await waitFor(() => expect(props.onRestore).toHaveBeenCalledWith('dsh-checkpoint-1'))
  })

  it('blocks restore confirmation when the preview detects an external conflict', async () => {
    renderDrawer({ onPreview: vi.fn().mockResolvedValue(preview(checkpoint(), true)) })
    fireEvent.click(screen.getByRole('button', { name: 'Restore Before refactor' }))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeDefined())
    expect(screen.getByText('1 file(s) changed externally; restore is blocked.')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Restore files' })).toHaveProperty('disabled', true)
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
