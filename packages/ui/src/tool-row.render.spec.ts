// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { ToolCallView } from '@dsh-vscode/domain'
import { ToolRow } from './components/ToolRow.js'

afterEach(() => cleanup())

describe('ToolRow rendering', () => {
  it('renders web search sources once instead of repeating them as generic targets', () => {
    const sourceUrl = 'https://weather.example.test/hangzhou'
    const tool: ToolCallView = {
      id: 'web-search-1',
      name: 'web_search',
      title: 'Search',
      category: 'tool',
      status: 'completed',
      metadata: {},
      presentation: {
        phase: 'result',
        card: 'web',
        kind: 'search',
        sources: [{ url: sourceUrl, title: 'Hangzhou weather' }],
        truncated: false,
      },
    }

    render(
      createElement(ToolRow, {
        tool,
        expanded: true,
        onToggle: vi.fn(),
        onOpenLink: vi.fn(),
      }),
    )

    expect(document.querySelectorAll('.dsh-tool-row__source')).toHaveLength(1)
    expect(document.querySelectorAll('.dsh-tool-row__targets .dsh-tool-row__target')).toHaveLength(0)
    expect(screen.getByRole('button', { name: sourceUrl })).toBeDefined()
  })
})
