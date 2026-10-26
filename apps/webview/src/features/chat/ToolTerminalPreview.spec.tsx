// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolTerminalRenderProps } from '@dsh-vscode/ui'
import { ToolTerminalPreview } from './ToolTerminalPreview.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function terminalProps(overrides: Partial<ToolTerminalRenderProps['view']> = {}): ToolTerminalRenderProps {
  return {
    view: {
      phase: 'result',
      card: 'terminal',
      output: 'all checks passed',
      exitCode: 0,
      ...overrides,
    },
  }
}

describe('ToolTerminalPreview', () => {
  it('renders all output, preserves raw copy text, and exposes the exit status', async () => {
    const lines = Array.from({ length: 18 }, (_, index) => `line [${index + 1}]`)
    const output = lines.join('\n') + '\n'
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { container } = render(<ToolTerminalPreview {...terminalProps({ output, exitCode: 2 })} />)

    for (const line of lines) expect(container.textContent).toContain(line)
    expect(container.textContent).toContain('Exit status: 2')

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(output))
  })
})
