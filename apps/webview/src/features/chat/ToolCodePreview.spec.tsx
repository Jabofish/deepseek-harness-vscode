// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCodeRenderProps } from '@dsh-vscode/ui'
import { ToolCodePreview } from './ToolCodePreview.js'
import { getWebviewHighlighter } from './shiki.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/**
 * Fetching the real Shiki bundle and one grammar is CPU-bound. Warm the shared
 * highlighter outside the assertion window so a loaded host cannot turn the
 * lazy highlight path into a timeout flake.
 */
async function warmHighlighter(): Promise<void> {
  await (await getWebviewHighlighter()).loadLanguage('typescript')
}

function codeProps(overrides: Partial<ToolCodeRenderProps> = {}): ToolCodeRenderProps {
  return {
    lines: [
      { number: 1, text: 'const answer = 42' },
      { number: 2, text: 'return answer' },
    ],
    language: 'ts',
    totalLines: 2,
    ...overrides,
  }
}

describe('ToolCodePreview', () => {
  it('folds the middle of long read windows and preserves file line numbers', () => {
    const lines = Array.from({ length: 18 }, (_, index) => ({
      number: index + 101,
      text: `line ${index + 101}`,
    }))
    const { container } = render(<ToolCodePreview {...codeProps({ lines, totalLines: 40 })} />)

    expect(container.querySelectorAll('.dsh-tool-code-preview__line')).toHaveLength(16)
    expect(container.textContent).toContain('line 101')
    expect(container.textContent).toContain('line 108')
    expect(container.textContent).toContain('line 111')
    expect(container.textContent).toContain('line 118')
    expect(container.textContent).not.toContain('line 109')
    expect(screen.getByRole('button', { name: 'Show 2 more lines' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more lines' }))
    expect(container.querySelectorAll('.dsh-tool-code-preview__line')).toHaveLength(18)
    expect(container.textContent).toContain('line 109')
    expect(screen.getByRole('button', { name: 'Show fewer lines' })).toBeDefined()
  })

  it('copies only source text and keeps highlighting lazy with a plaintext fallback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await warmHighlighter()
    const { container } = render(<ToolCodePreview {...codeProps()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const answer = 42\nreturn answer'))
    await waitFor(() => expect(container.querySelector('[data-highlighted="true"]')).not.toBeNull(), {
      timeout: 5_000,
    })
    expect(container.querySelectorAll('.dsh-tool-code-preview__token').length).toBeGreaterThan(0)
    expect(container.textContent).toContain('const answer = 42')
  })

  it('keeps an unknown grammar visible as plain text', async () => {
    const { container } = render(<ToolCodePreview {...codeProps({ language: 'not-a-language' })} />)

    await waitFor(() => expect(container.querySelector('[data-highlighted="false"]')).not.toBeNull())
    expect(container.textContent).toContain('const answer = 42')
    expect(container.querySelectorAll('.dsh-tool-code-preview__token')).toHaveLength(0)
  })

  it('keeps a complete unlabeled read window from rendering an empty full-width toolbar', () => {
    const { container } = render(<ToolCodePreview {...codeProps({ language: '' })} />)

    expect(container.querySelector('.dsh-tool-code-preview__toolbar--minimal')).not.toBeNull()
    expect(container.querySelector('.dsh-tool-code-preview__copy')).not.toBeNull()
  })

  it('keeps an empty read window explicit without offering an empty copy', () => {
    const { container } = render(<ToolCodePreview {...codeProps({ lines: [], totalLines: 20 })} />)

    expect(container.textContent).toContain('Showing 0 of 20 lines')
    expect(container.querySelectorAll('.dsh-tool-code-preview__line')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()
  })
})
