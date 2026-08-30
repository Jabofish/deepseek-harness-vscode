// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

    const onOpenLink = vi.fn()
    render(
      createElement(ToolRow, {
        tool,
        expanded: true,
        onToggle: vi.fn(),
        onOpenLink,
      }),
    )

    expect(document.querySelectorAll('.dsh-tool-row__source')).toHaveLength(1)
    expect(document.querySelectorAll('.dsh-tool-row__targets .dsh-tool-row__target')).toHaveLength(0)
    expect(screen.getByRole('button', { name: sourceUrl })).toBeDefined()
    expect(onOpenLink).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: sourceUrl }))
    expect(onOpenLink).toHaveBeenCalledWith(sourceUrl)
  })

  it('does not reserve empty metadata rows above a web source link', () => {
    const sourceUrl = 'https://weather.example.test/empty-metadata'
    const tool: ToolCallView = {
      id: 'web-search-empty-metadata',
      name: 'web_search',
      title: 'Search',
      category: 'tool',
      status: 'completed',
      metadata: {},
      presentation: {
        phase: 'result',
        card: 'web',
        kind: 'search',
        sources: [{ url: sourceUrl, title: '', snippet: ' ', publishedAt: '' }],
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

    const source = document.querySelector('.dsh-tool-row__source')
    expect(source?.querySelector('strong')).toBeNull()
    expect(source?.querySelector('.dsh-tool-row__source-snippet')).toBeNull()
    expect(source?.querySelector('time')).toBeNull()
    expect(screen.getByRole('button', { name: sourceUrl }).textContent).toBe(sourceUrl)
  })
})
