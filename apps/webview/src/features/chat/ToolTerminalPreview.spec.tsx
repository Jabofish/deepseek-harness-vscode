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
  it('folds output, preserves raw copy text, and exposes the exit status', async () => {
    const output = Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join('\n') + '\n'
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { container } = render(<ToolTerminalPreview {...terminalProps({ output, exitCode: 2 })} />)

    expect(container.querySelectorAll('.dsh-tool-terminal-preview__line')).toHaveLength(16)
    expect(container.textContent).toContain('line 1')
    expect(container.textContent).toContain('line 8')
    expect(container.textContent).toContain('line 11')
    expect(container.textContent).toContain('line 18')
    expect(container.textContent).not.toContain('line 9')
    expect(container.textContent).toContain('Exit status: 2')
    expect(screen.getByRole('button', { name: 'Show 2 more output lines' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(output))

    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more output lines' }))
    expect(container.querySelectorAll('.dsh-tool-terminal-preview__line')).toHaveLength(18)
    expect(screen.getByRole('button', { name: 'Show fewer output lines' })).toBeDefined()
  })

  it('gives a terminating signal precedence over an exit code', () => {
    const { container } = render(
      <ToolTerminalPreview {...terminalProps({ output: 'stopped', exitCode: 0, signal: 'SIGTERM' })} />,
    )

    expect(container.textContent).toContain('Signal: SIGTERM')
    expect(container.textContent).not.toContain('Exit status: 0')
    expect(container.querySelector('.dsh-tool-terminal-preview__status--error')).not.toBeNull()
  })

  it('shows an explicit empty result without offering an empty copy', () => {
    const { container } = render(<ToolTerminalPreview {...terminalProps({ output: ' \n' })} />)

    expect(container.querySelector('[data-terminal]')?.getAttribute('data-empty')).toBe('true')
    expect(container.textContent).toContain('No output')
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()
    expect(container.querySelector('.dsh-tool-terminal-preview__body')).toBeNull()
  })
})
