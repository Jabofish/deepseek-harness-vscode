// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import type { ToolCallView } from '@dsh-vscode/domain'
import { ToolCard } from './components/ToolCard.js'

afterEach(() => cleanup())

describe('ToolCard', () => {
  it('formats the real question result shape before it reaches the generic card DOM', () => {
    const tool: ToolCallView = {
      id: 'question-call-1',
      name: 'question',
      title: '问题',
      category: 'tool',
      status: 'completed',
      inputSummary: JSON.stringify({
        questions: [
          {
            id: 'today_temperature',
            question: '请问您所在地区今日的温度大概是多少？',
            options: [{ label: '温和 (15-25°C)' }],
          },
        ],
      }),
      outputSummary: JSON.stringify({
        answers: [{ id: 'today_temperature', selected: ['温和 (15-25°C)'] }],
      }),
      metadata: {},
    }

    render(createElement(ToolCard, { tool, expanded: true, onToggle: () => undefined }))

    const details = document.querySelector('.dsh-tool-card__details')
    expect(details?.textContent).toContain('Answers')
    expect(details?.textContent).toContain('温和 (15-25°C)')
    expect(details?.textContent).not.toContain('{"answers"')
    expect(details?.textContent).not.toContain('"selected"')
  })

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

    const details = document.querySelector('.dsh-tool-card__details')
    expect(details?.textContent).toContain('--include=src/feature-119/**')
    expect(details?.textContent).toContain('row 90: the tool reported this line to the caller')
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

    const section = document.querySelector('.dsh-tool-card__section--error')
    expect(section?.textContent).toContain('field-89 is required but was missing from the payload')
  })
})
