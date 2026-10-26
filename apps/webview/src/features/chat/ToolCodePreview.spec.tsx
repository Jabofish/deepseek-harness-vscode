// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCodeRenderProps } from '@dsh-vscode/ui'
import { ToolCodePreview } from './ToolCodePreview.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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
  it('displays source and copies it without line numbers or metadata', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { container } = render(<ToolCodePreview {...codeProps()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const answer = 42\nreturn answer'))
    expect(container.textContent).toContain('const answer = 42')
  })
})
