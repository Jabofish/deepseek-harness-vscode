// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { ToolCallView } from '@dsh-vscode/domain'
import { ToolRendererRegistry } from './tool-renderer-registry.js'

afterEach(cleanup)

const tool: ToolCallView = {
  id: 'custom-tool',
  name: 'custom_tool',
  category: 'tool',
  title: 'Custom tool',
  status: 'completed',
  outputSummary: 'Complete fallback output',
  metadata: {},
}

it('routes a generic tool denial to its safe explanation without exposing call data', () => {
  const registry = new ToolRendererRegistry()
  const { container } = render(
    registry.render(
      {
        ...tool,
        status: 'failed',
        inputSummary: 'private arguments',
        outputSummary: 'private result',
        autoReviewDenial: { reason: 'Outside the approved scope' },
      },
      { expanded: true },
    ),
  )
  expect(screen.getByRole('alert').textContent).toContain('Outside the approved scope')
  expect(screen.getByRole('alert').textContent).toContain('Tool was not executed.')
  expect(container.textContent).not.toContain('private arguments')
  expect(container.textContent).not.toContain('private result')
})
