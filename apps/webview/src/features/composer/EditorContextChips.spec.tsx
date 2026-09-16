// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorContextItem, EditorContextPreview } from '@dsh-vscode/domain'

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

const secondItem: EditorContextItem = {
  ...item,
  ref: { ...item.ref, contextRef: 'dsh-context:context-2', relativePath: 'src/other.ts' },
  label: 'file: src/other.ts',
}

const preview: EditorContextPreview = {
  contextRef: item.ref.contextRef,
  text: 'export const a = 1',
  truncated: false,
  expiresAt: 4_000,
}

function renderChips(
  overrides: Partial<Parameters<typeof EditorContextChips>[0]> = {},
): ReturnType<typeof render> {
  const props = {
    items: [item] as readonly EditorContextItem[],
    disabled: false,
    onRemove: vi.fn(),
    onPreview: vi.fn().mockResolvedValue(preview),
    ...overrides,
  }
  return render(<EditorContextChips {...props} />)
}

/** Settle the effects a dialog opened from an awaited Host call still owes. */
async function flushPendingEffects(): Promise<void> {
  await act(() => Promise.resolve())
}

/** The preview is fetched on click; every probe starts from an open dialog. */
async function openPreview(target: EditorContextItem = item): Promise<void> {
  fireEvent.click(
    screen.getByRole('button', {
      name: `Preview file: ${target.ref.relativePath}`,
    }),
  )
  await screen.findByRole('dialog', { name: 'Editor context preview' })
  // The preview text arrives from a Host round trip, so the layer's document
  // listener is armed one task after the dialog becomes visible.
  await flushPendingEffects()
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

  it('closes the preview on Escape', async () => {
    renderChips()
    await openPreview()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Editor context preview' })).toBeNull()
  })

  it('closes the preview when the pointer goes elsewhere in the composer', async () => {
    renderChips()
    await openPreview()

    fireEvent.pointerDown(document.body)

    expect(screen.queryByRole('dialog', { name: 'Editor context preview' })).toBeNull()
  })

  it('drops the preview when its context chip is removed', async () => {
    const { rerender } = renderChips({ items: [item, secondItem] })
    await openPreview()

    rerender(
      <EditorContextChips
        items={[secondItem]}
        disabled={false}
        onRemove={vi.fn()}
        onPreview={vi.fn().mockResolvedValue(preview)}
      />,
    )

    expect(screen.queryByRole('dialog', { name: 'Editor context preview' })).toBeNull()
  })

  it('keeps the preview while its own chip is still attached', async () => {
    const { rerender } = renderChips({ items: [item, secondItem] })
    await openPreview()

    rerender(
      <EditorContextChips
        items={[item]}
        disabled={false}
        onRemove={vi.fn()}
        onPreview={vi.fn().mockResolvedValue(preview)}
      />,
    )

    expect(screen.getByRole('dialog', { name: 'Editor context preview' })).toBeDefined()
    expect(screen.getByText('export const a = 1')).toBeDefined()
  })
})
