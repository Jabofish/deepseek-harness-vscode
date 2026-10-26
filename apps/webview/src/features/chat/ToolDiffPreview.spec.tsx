// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolDiffRenderProps } from '@dsh-vscode/ui'
import { ToolDiffPreview } from './ToolDiffPreview.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function diffProps(overrides: Partial<ToolDiffRenderProps> = {}): ToolDiffRenderProps {
  return {
    diffs: [{ path: 'src/feature.ts', oldText: 'before', newText: 'after' }],
    ...overrides,
  }
}

describe('ToolDiffPreview', () => {
  it('renders creates, repeated-file gaps, distinct-file totals, and copy text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { container } = render(
      <ToolDiffPreview
        {...diffProps({
          diffs: [
            { path: 'src/a.ts', oldText: 'old\n', newText: 'new\n' },
            { path: 'src/a.ts', oldText: 'before', newText: 'after' },
            { path: 'src/b.ts', oldText: null, newText: 'one\ntwo\n' },
          ],
        })}
      />,
    )

    expect(container.textContent).toContain('src/a.ts')
    expect(container.textContent).toContain('src/b.ts')

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'src/a.ts\n- old\n+ new\n⋯\n- before\n+ after\nsrc/b.ts\n+ one\n+ two',
      ),
    )
  })
})
