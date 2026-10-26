// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { ToolCallView } from '@dsh-vscode/domain'
import { ToolRow } from './components/ToolRow.js'

afterEach(() => cleanup())

describe('ToolRow rendering', () => {
  it('falls back to the shared diff view when an optional renderer fails', () => {
    const tool: ToolCallView = {
      id: 'broken-diff-renderer',
      name: 'edit',
      title: 'Edit',
      category: 'tool',
      status: 'completed',
      metadata: {},
      presentation: {
        phase: 'result',
        card: 'diff',
        diffs: [{ path: 'src/feature.ts', oldText: 'before', newText: 'after' }],
      },
    }

    render(
      createElement(ToolRow, {
        tool,
        expanded: true,
        onToggle: vi.fn(),
        renderDiff: () => {
          throw new Error('renderer failure')
        },
      }),
    )

    expect(screen.getByText('src/feature.ts')).toBeDefined()
    expect(document.body.textContent).toContain('before')
  })

  it('shows only the not-executed and manual-approval explanation for Auto review denial', () => {
    const tool: ToolCallView = {
      id: 'auto-review-denied',
      name: 'future_custom_tool',
      title: 'Custom action',
      category: 'tool',
      status: 'failed',
      inputSummary: '{"secretArgument":"private input"}',
      outputSummary: 'private output',
      error: 'raw error text',
      autoReviewDenial: { reason: 'blocked by scope\nrequest review' },
      metadata: {},
    }
    const { container } = render(createElement(ToolRow, { tool, expanded: true, onToggle: vi.fn() }))
    const explanation = screen.getByRole('alert').textContent
    expect(explanation).toContain('Rejected by Auto review')
    expect(explanation).toContain('Tool was not executed.')
    expect(explanation).toContain('Manual approval is required to continue.')
    expect(explanation).toContain('blocked by scope request review')
    expect(container.textContent).not.toContain('private input')
    expect(container.textContent).not.toContain('private output')
    expect(container.textContent).not.toContain('raw error text')
  })

  it('shows a long tool failure text the host sent, not a clipped preview', () => {
    // DSH keeps a failed tool's message whole and a compiler, linter or
    // validation failure routinely runs past any card-sized preview; the error
    // section is the only surface that carries this text, so a clip here is the
    // user's whole diagnosis.
    const lines = Array.from(
      { length: 80 },
      (_, index) => `src/feature-${index}.ts:12:5 error no-unused-vars: 'value' is assigned but never used`,
    )
    const failure = `Exit code 2: 80 problems found.\n${lines.join('\n')}`
    expect(failure.length).toBeGreaterThan(4_096)
    const tool: ToolCallView = {
      id: 'long-failure',
      name: 'bash',
      title: 'Bash',
      category: 'tool',
      status: 'failed',
      error: failure,
      metadata: {},
    }

    render(createElement(ToolRow, { tool, expanded: true, onToggle: vi.fn() }))

    expect(screen.getByText(failure, { normalizer: (text) => text }).textContent).toBe(failure)
  })
})
