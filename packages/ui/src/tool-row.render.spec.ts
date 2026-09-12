// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { ToolCallView } from '@dsh-vscode/domain'
import { ToolRow } from './components/ToolRow.js'

afterEach(() => cleanup())

describe('ToolRow rendering', () => {
  it('hands structured diffs to the optional host diff renderer', () => {
    const diffs = [{ path: 'src/feature.ts', oldText: 'before', newText: 'after' }]
    const tool: ToolCallView = {
      id: 'diff-renderer',
      name: 'edit',
      title: 'Edit',
      category: 'tool',
      status: 'completed',
      metadata: {},
      presentation: {
        phase: 'result',
        card: 'diff',
        diffs,
      },
    }

    render(
      createElement(ToolRow, {
        tool,
        expanded: true,
        onToggle: vi.fn(),
        renderDiff: ({ diffs: value }) =>
          createElement('output', { 'data-diff-renderer': value[0]?.newText }, 'custom diff'),
      }),
    )

    expect(document.querySelector('[data-diff-renderer="after"]')?.textContent).toBe('custom diff')
    expect(document.querySelector('.dsh-tool-row__diff-file')).toBeNull()
  })

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

    expect(document.querySelector('.dsh-tool-row__diff-file-name')?.textContent).toBe('src/feature.ts')
    expect(document.querySelector('.dsh-tool-row__diff-line--remove')?.textContent).toContain('before')
  })

  it('hands structured terminal results to the optional host terminal renderer', () => {
    const tool: ToolCallView = {
      id: 'terminal-renderer',
      name: 'bash',
      title: 'Bash',
      category: 'tool',
      status: 'completed',
      metadata: {},
      presentation: {
        phase: 'result',
        card: 'terminal',
        output: 'all checks passed',
        exitCode: 0,
      },
    }

    render(
      createElement(ToolRow, {
        tool,
        expanded: true,
        onToggle: vi.fn(),
        renderTerminal: ({ view }) =>
          createElement('output', { 'data-terminal-renderer': view.output }, 'custom terminal'),
      }),
    )

    expect(document.querySelector('[data-terminal-renderer="all checks passed"]')?.textContent).toBe(
      'custom terminal',
    )
    expect(document.querySelector('.dsh-tool-row__terminal-output')).toBeNull()
  })

  it('hands both structured search shapes to the optional host search renderer', () => {
    const tool: ToolCallView = {
      id: 'search-renderer',
      name: 'glob',
      title: 'Search',
      category: 'tool',
      status: 'completed',
      metadata: {},
      presentation: {
        phase: 'result',
        card: 'search',
        shape: 'paths',
        paths: ['src/feature.ts'],
        truncated: false,
        total: 1,
      },
    }

    render(
      createElement(ToolRow, {
        tool,
        expanded: true,
        onToggle: vi.fn(),
        renderSearch: ({ view }) =>
          createElement(
            'output',
            { 'data-search-renderer': view.shape },
            view.shape === 'paths' ? view.paths.join(',') : '',
          ),
      }),
    )

    expect(document.querySelector('[data-search-renderer="paths"]')?.textContent).toBe('src/feature.ts')
    expect(document.querySelector('.dsh-tool-row__search-files')).toBeNull()
  })

  it('hands structured read lines to the optional host code renderer', () => {
    const tool: ToolCallView = {
      id: 'read-code-renderer',
      name: 'read',
      title: 'Read',
      category: 'tool',
      status: 'completed',
      metadata: {},
      presentation: {
        phase: 'result',
        card: 'read',
        path: 'src/feature.ts',
        offset: 11,
        lines: [{ number: 11, text: 'const answer = 42' }],
        totalLines: 42,
        lang: 'ts',
      },
    }

    render(
      createElement(ToolRow, {
        tool,
        expanded: true,
        onToggle: vi.fn(),
        renderCode: ({ lines, language, totalLines }) =>
          createElement('output', { 'data-code-renderer': `${language}:${totalLines}` }, lines[0]?.text),
      }),
    )

    expect(document.querySelector('[data-code-renderer="ts:42"]')?.textContent).toBe('const answer = 42')
    expect(document.querySelector('.dsh-tool-row__read-code')).toBeNull()
  })

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
