// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { ToolCallView } from '@dsh-vscode/domain'
import { ToolCard } from './components/ToolCard.js'

afterEach(() => cleanup())

describe('ToolCard', () => {
  it('shows the whole request and result text a third-party tool exchanged', () => {
    // A tool outside the built-in catalog keeps its own request and result
    // text, and DSH bounds neither: the generic card is the only surface that
    // carries them, so it must not end them in an ellipsis of its own.
    const request = Array.from({ length: 120 }, (_, index) => `--include=src/feature-${index}/**`).join(' ')
    const result = Array.from(
      { length: 90 },
      (_, index) => `row ${index + 1}: the tool reported this line to the caller`,
    ).join('\n')
    expect(request.length).toBeGreaterThan(2_000)
    expect(result.length).toBeGreaterThan(2_000)
    const tool: ToolCallView = {
      id: 'third-party-call-1',
      name: 'filesystem_search',
      title: 'Search files',
      category: 'tool',
      status: 'completed',
      inputSummary: JSON.stringify({ command: request }),
      outputSummary: result,
      metadata: {},
    }

    render(createElement(ToolCard, { tool, expanded: true, onToggle: () => undefined }))

    expect(document.body.textContent).toContain(request)
    expect(document.body.textContent).toContain(result)
  })

  it('shows a long tool failure text whole in the generic card', () => {
    const failure = `Validation failed:\n${Array.from(
      { length: 90 },
      (_, index) => `field-${index} is required but was missing from the payload`,
    ).join('\n')}`
    expect(failure.length).toBeGreaterThan(2_000)
    const tool: ToolCallView = {
      id: 'third-party-call-2',
      name: 'filesystem_search',
      title: 'Search files',
      category: 'tool',
      status: 'failed',
      error: failure,
      metadata: {},
    }

    render(createElement(ToolCard, { tool, expanded: true, onToggle: () => undefined }))

    expect(document.body.textContent).toContain(failure)
  })

  it('opens the file addressed by a safe generic-tool location', () => {
    const filePath = 'D:\\CS\\deepseek-harness-vscode\\.test-workspace\\hello.txt'
    const onOpenLink = vi.fn()
    const tool: ToolCallView = {
      id: 'generic-location-target',
      name: 'filesystem_search',
      title: 'Search files',
      category: 'tool',
      status: 'completed',
      locations: [{ path: filePath, line: 3 }],
      metadata: {},
    }

    render(createElement(ToolCard, { tool, expanded: true, onToggle: () => undefined, onOpenLink }))

    const target = screen.getByText(`${filePath}:4`)
    expect(target.textContent).toBe(`${filePath}:4`)
    fireEvent.click(target)
    expect(onOpenLink).toHaveBeenCalledWith(filePath)
  })
})
