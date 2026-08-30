// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorContextItem } from '@dsh-vscode/domain'

import { EditorContextChips } from './EditorContextChips.js'

const item: EditorContextItem = {
  ref: {
    contextRef: 'dsh-context:context-1',
    workspaceFolderId: 'workspace-1',
    ownerId: 'owner',
    ownerViewId: 'view',
    contextStoreGeneration: 1,
    kind: 'file',
    relativePath: 'src/main.ts',
    sizeBytes: 12,
    capturedAt: 1_000,
    contentHash: 'a'.repeat(64),
    expiresAt: 2_000,
  },
  label: 'file: src/main.ts',
  stale: false,
  previewAvailable: true,
}

describe('EditorContextChips', () => {
  afterEach(() => cleanup())

  it('handles an expired preview without an unhandled rejection', async () => {
    render(
      <EditorContextChips
        items={[item]}
        disabled={false}
        onRemove={vi.fn()}
        onPreview={vi.fn().mockRejectedValue(new Error('expired'))}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Preview file: src/main.ts' }))
    await waitFor(() => expect(screen.getByText('The context preview is no longer available.')).toBeDefined())
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
