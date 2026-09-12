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

    expect(container.querySelectorAll('.dsh-tool-diff-preview__line--path')).toHaveLength(2)
    expect(container.querySelectorAll('.dsh-tool-diff-preview__line--gap')).toHaveLength(1)
    expect(container.querySelectorAll('.dsh-tool-diff-preview__line--del')).toHaveLength(2)
    expect(container.querySelectorAll('.dsh-tool-diff-preview__line--add')).toHaveLength(4)
    expect(container.textContent).toContain('└ +4 -2 · 2 file(s)')

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'src/a.ts\n- old\n+ new\n⋯\n- before\n+ after\nsrc/b.ts\n+ one\n+ two',
      ),
    )
  })

  it('folds the middle while keeping all diff rows available after expansion', () => {
    const diffs = Array.from({ length: 10 }, (_, index) => ({
      path: `src/${index}.ts`,
      oldText: null,
      newText: `line ${index}`,
    }))
    const { container } = render(<ToolDiffPreview {...diffProps({ diffs })} />)

    expect(container.querySelectorAll('.dsh-tool-diff-preview__line')).toHaveLength(16)
    expect(container.textContent).toContain('src/0.ts')
    expect(container.textContent).toContain('src/9.ts')
    expect(container.textContent).not.toContain('src/5.ts')
    expect(screen.getByRole('button', { name: 'Show 4 more diff lines' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Show 4 more diff lines' }))
    expect(container.querySelectorAll('.dsh-tool-diff-preview__line')).toHaveLength(20)
    expect(container.textContent).toContain('src/5.ts')
    expect(screen.getByRole('button', { name: 'Show fewer diff lines' })).toBeDefined()
  })

  it('renders no empty card when the validated diff list is empty', () => {
    const { container } = render(<ToolDiffPreview {...diffProps({ diffs: [] })} />)

    expect(container.textContent).toBe('')
    expect(container.querySelector('[data-diff]')).toBeNull()
  })
})
