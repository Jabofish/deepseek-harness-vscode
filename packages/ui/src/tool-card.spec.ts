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
})
