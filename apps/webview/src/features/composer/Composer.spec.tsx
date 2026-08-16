// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer.js'

describe('Composer', () => {
  afterEach(() => cleanup())

  it('keeps attachment controls usable when names are long', () => {
    const name = 'diagnostics-from-a-narrow-vscode-window.txt'
    render(
      <Composer
        disabled={false}
        running={false}
        draft=""
        attachments={[{ uri: 'dsh-attachment:test-file', name, mimeType: 'text/plain' }]}
        onDraftChange={vi.fn()}
        onPickAttachment={vi.fn()}
        openFileCandidates={[{ id: 'dsh-open-file-current', name: 'LICENSE', active: true, supported: true }]}
        openFilePickerOpen={false}
        openFilePickerLoading={false}
        attachedOpenFileIds={[]}
        onToggleOpenFilePicker={vi.fn()}
        onSelectOpenFile={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Attach file' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Choose an open file' })).toBeDefined()
    expect(screen.getByRole('button', { name: `Remove ${name}` })).toBeDefined()
    expect(screen.getByText(name).getAttribute('title')).toBe(name)
    expect(screen.getByRole('textbox', { name: 'Prompt' }).className).toContain('dsh-composer__textarea')
  })
})
