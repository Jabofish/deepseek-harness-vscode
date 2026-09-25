// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'
import type { ToolCallView } from '@dsh-vscode/domain'
import { ToolRow, type ToolSearchRenderProps } from './components/ToolRow.js'

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

  it('draws one header per file and a gap between two hunks of the same file', () => {
    // The host computes one diff per applied hunk, so a scattered edit of one
    // file arrives as several entries under the same path. Rendering one block
    // per entry repeated the file name once per hunk and told the reader the
    // card had as many files as the edit had hunks.
    const tool: ToolCallView = {
      id: 'multi-hunk-diff',
      name: 'edit',
      title: 'Edit',
      category: 'tool',
      status: 'completed',
      metadata: {},
      presentation: {
        phase: 'result',
        card: 'diff',
        diffs: [
          { path: 'src/feature.ts', oldText: 'first-old', newText: 'first-new' },
          { path: 'src/feature.ts', oldText: 'second-old', newText: 'second-new' },
          { path: 'src/other.ts', oldText: 'third-old', newText: 'third-new' },
        ],
      },
    }

    const { container } = render(createElement(ToolRow, { tool, expanded: true, onToggle: vi.fn() }))

    const files = container.querySelectorAll('.dsh-tool-row__diff-file')
    expect(files).toHaveLength(2)
    expect(
      [...container.querySelectorAll('.dsh-tool-row__diff-file-name')].map((node) => node.textContent),
    ).toEqual(['src/feature.ts', 'src/other.ts'])
    expect(files[0]?.querySelectorAll('.dsh-tool-row__diff-lines')).toHaveLength(2)
    expect(files[0]?.querySelectorAll('.dsh-tool-row__diff-gap')).toHaveLength(1)
    expect(files[0]?.querySelector('.dsh-tool-row__diff-gap')?.textContent).toBe('⋯')
    // The gap belongs between the hunks of one file, not after its last hunk.
    expect(files[1]?.querySelectorAll('.dsh-tool-row__diff-gap')).toHaveLength(0)
  })

  it('counts files rather than hunks in the diff footer', () => {
    const tool: ToolCallView = {
      id: 'diff-footer-count',
      name: 'edit',
      title: 'Edit',
      category: 'tool',
      status: 'completed',
      metadata: {},
      presentation: {
        phase: 'result',
        card: 'diff',
        diffs: [
          { path: 'src/feature.ts', oldText: 'a', newText: 'b' },
          { path: 'src/feature.ts', oldText: 'c', newText: 'd' },
          { path: 'src/other.ts', oldText: 'e', newText: 'f' },
        ],
      },
    }

    const { container } = render(createElement(ToolRow, { tool, expanded: true, onToggle: vi.fn() }))

    expect(container.querySelector('.dsh-tool-row__diff-footer')?.textContent).toBe('2 files')
  })

  it('renders two hunks of one file without a duplicate-key warning', () => {
    // React keyed each block by its path, so the second hunk of a file collided
    // with the first and the reconciliation of an edited row was unstable.
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(' '))
    })
    const tool: ToolCallView = {
      id: 'diff-key-collision',
      name: 'edit',
      title: 'Edit',
      category: 'tool',
      status: 'completed',
      metadata: {},
      presentation: {
        phase: 'result',
        card: 'diff',
        diffs: [
          { path: 'src/feature.ts', oldText: 'a', newText: 'b' },
          { path: 'src/feature.ts', oldText: 'c', newText: 'd' },
        ],
      },
    }
    try {
      render(createElement(ToolRow, { tool, expanded: true, onToggle: vi.fn() }))
    } finally {
      spy.mockRestore()
    }

    expect(errors.filter((message) => message.includes('same key'))).toEqual([])
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

  it("hands a capped search's raw result text back to renderers that replaced it", () => {
    // The card holds the retained rows only; the `Full … stored at <locator>`
    // footer that reaches the rows the host cap dropped lives in the result text
    // alone, so the renderer that took over the details surface needs it.
    const footer = 'Full glob result stored at: .dsh/spill/glob.txt. Read the file for the complete list.'
    const searchTool = (truncated: boolean): ToolCallView => ({
      id: 'search-recovery',
      name: 'glob',
      title: 'Search',
      category: 'tool',
      status: 'completed',
      outputSummary: `src/feature.ts\n(${footer})`,
      metadata: {},
      presentation: {
        phase: 'result',
        card: 'search',
        shape: 'paths',
        paths: ['src/feature.ts'],
        truncated,
        total: truncated ? 900 : 1,
      },
    })

    const seen: (string | undefined)[] = []
    const renderSearch = (props: ToolSearchRenderProps): ReactElement => {
      seen.push(props.recovery)
      return createElement('output', { 'data-search-renderer': 'paths' }, props.recovery ?? 'no recovery')
    }

    const { unmount } = render(
      createElement(ToolRow, { tool: searchTool(true), expanded: true, onToggle: vi.fn(), renderSearch }),
    )
    expect(seen).toEqual([`src/feature.ts\n(${footer})`])
    unmount()

    const fallback = render(
      createElement(ToolRow, { tool: searchTool(true), expanded: true, onToggle: vi.fn() }),
    )
    expect(fallback.container.textContent).toContain(footer)
    unmount()

    render(
      createElement(ToolRow, { tool: searchTool(false), expanded: true, onToggle: vi.fn(), renderSearch }),
    )
    expect(seen).toEqual([`src/feature.ts\n(${footer})`, undefined])
  })

  it('hands structured web results to the optional host web renderer', () => {
    const tool: ToolCallView = {
      id: 'web-renderer',
      name: 'web_fetch',
      title: 'Fetch',
      category: 'tool',
      status: 'completed',
      metadata: {},
      presentation: {
        phase: 'result',
        card: 'web',
        kind: 'fetch',
        url: 'https://example.test/page',
        statusCode: 200,
        truncated: false,
      },
    }

    render(
      createElement(ToolRow, {
        tool,
        expanded: true,
        onToggle: vi.fn(),
        onOpenLink: vi.fn(),
        renderWeb: ({ view }) => createElement('output', { 'data-web-renderer': view.kind }, 'custom web'),
      }),
    )

    expect(document.querySelector('[data-web-renderer="fetch"]')?.textContent).toBe('custom web')
    expect(document.querySelector('.dsh-tool-row__targets')).toBeNull()
  })

  it('opens a fetched page from a collapsed row without expanding it', () => {
    const href = 'https://example.test/collapsed-page'
    const tool: ToolCallView = {
      id: 'web-fetch-collapsed',
      name: 'web_fetch',
      title: 'Fetch',
      category: 'tool',
      status: 'completed',
      metadata: {},
      presentation: {
        phase: 'result',
        card: 'web',
        kind: 'fetch',
        url: href,
        statusCode: 200,
        truncated: false,
      },
    }
    const onOpenLink = vi.fn()
    const onToggle = vi.fn()

    render(
      createElement(ToolRow, {
        tool,
        expanded: false,
        onToggle,
        onOpenLink,
        renderWeb: ({ view }) => createElement('output', { 'data-web-renderer': view.kind }, 'custom web'),
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: `Open fetched page ${href}` }))
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(href)
    expect(onToggle).not.toHaveBeenCalled()
    expect(document.querySelector('.dsh-tool-row__details')).toBeNull()
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
    const details = container.querySelector('.dsh-tool-row__details')
    const detailsText = details?.textContent ?? ''

    expect(container.querySelector('.dsh-tool-row__summary-text')?.textContent).toBe(
      'Rejected by Auto review',
    )
    expect(details?.querySelector('[role="alert"]')?.textContent).toBe(
      'Rejected by Auto reviewTool was not executed. Manual approval is required to continue. Reason: blocked by scope request review',
    )
    expect(detailsText).not.toContain('private input')
    expect(detailsText).not.toContain('private output')
    expect(detailsText).not.toContain('raw error text')
    expect(container.querySelectorAll('.dsh-tool-row__section--error')).toHaveLength(1)
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

  it('renders a shell row whose command failed as a failed row', () => {
    // The host settles a failing command as a completed call, so the card's own
    // exit status is the row's only failure signal: a green "Completed" row with
    // a red exit pill inside would state both.
    const failing = (presentation: NonNullable<ToolCallView['presentation']>, id: string): ToolCallView => ({
      id,
      name: 'bash',
      title: 'Bash',
      category: 'tool',
      status: 'completed',
      metadata: {},
      presentation,
    })

    const { container } = render(
      createElement('div', null, [
        createElement(ToolRow, {
          key: 'failed',
          tool: failing({ phase: 'result', card: 'terminal', output: 'boom', exitCode: 2 }, 'failed-exit'),
          expanded: true,
          onToggle: vi.fn(),
        }),
        createElement(ToolRow, {
          key: 'clean',
          tool: failing({ phase: 'result', card: 'terminal', output: 'ok', exitCode: 0 }, 'clean-exit'),
          expanded: true,
          onToggle: vi.fn(),
        }),
      ]),
    )

    const rows = container.querySelectorAll('.dsh-tool-row')
    expect(rows[0]?.getAttribute('data-state')).toBe('error')
    expect(rows[0]?.querySelector('.dsh-tool-row__status')?.textContent).toBe('Failed')
    expect(rows[0]?.querySelector('.dsh-tool-row__section--error')).toBeNull()
    expect(rows[0]?.querySelector('.dsh-tool-row__exit-pill')?.textContent).toBe('2')
    expect(rows[1]?.getAttribute('data-state')).toBe('ok')
    expect(rows[1]?.querySelector('.dsh-tool-row__status')?.textContent).toBe('Completed')
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

    expect(document.querySelector('.dsh-tool-row__section--error pre')?.textContent).toBe(failure)
  })

  it('renders one error section for a failed structured tool', () => {
    const failure =
      'Error: old_string was not found in "D:\\CS\\deepseek-harness-vscode\\test-workspace\\hello.txt"'
    const tool: ToolCallView = {
      id: 'single-structured-failure',
      name: 'edit',
      title: 'Edit',
      category: 'tool',
      status: 'failed',
      error: failure,
      metadata: {},
      presentation: {
        phase: 'result',
        card: 'diff',
        diffs: [{ path: 'test-workspace/hello.txt', oldText: 'Part A', newText: 'Phase 1' }],
      },
    }

    const { container } = render(createElement(ToolRow, { tool, expanded: true, onToggle: vi.fn() }))

    expect(container.querySelectorAll('.dsh-tool-row__section--error')).toHaveLength(1)
    expect(container.querySelector('.dsh-tool-row__section--error pre')?.textContent).toBe(failure)
  })

  it('does not repeat a structured result when it is the same as the tool error', () => {
    const failure =
      'Error: old_string was not found in "D:\\CS\\deepseek-harness-vscode\\test-workspace\\hello.txt"'
    const tool: ToolCallView = {
      id: 'structured-error-result',
      name: 'bash',
      title: 'Bash',
      category: 'tool',
      status: 'failed',
      error: failure,
      metadata: {},
      presentation: {
        phase: 'result',
        card: 'terminal',
        output: failure,
        exitCode: 1,
      },
    }

    const { container } = render(createElement(ToolRow, { tool, expanded: true, onToggle: vi.fn() }))
    const details = container.querySelector('.dsh-tool-row__details')
    const detailsText = details?.textContent ?? ''

    expect(detailsText.split(failure).length - 1).toBe(1)
    expect(details?.querySelector('.dsh-tool-row__terminal-output')).toBeNull()
    expect(details?.querySelectorAll('.dsh-tool-row__section--error')).toHaveLength(1)
  })

  it('renders a top-level location once for a structured result without its own target list', () => {
    const filePath = 'D:\\CS\\deepseek-harness-vscode\\.test-workspace\\hello.txt'
    const onOpenLink = vi.fn()
    const tool: ToolCallView = {
      id: 'structured-location-target',
      name: 'grep',
      title: 'Search',
      category: 'tool',
      status: 'completed',
      locations: [{ path: filePath, line: 2 }],
      metadata: {},
      presentation: {
        phase: 'result',
        card: 'generic',
        content: ['match found'],
      },
    }

    render(createElement(ToolRow, { tool, expanded: true, onToggle: vi.fn(), onOpenLink }))

    const target = document.querySelector<HTMLButtonElement>('.dsh-tool-row__target')
    expect(target?.textContent).toBe(filePath)
    expect(document.querySelectorAll('.dsh-tool-row__target')).toHaveLength(1)
    fireEvent.click(target!)
    expect(onOpenLink).toHaveBeenCalledWith(filePath)
  })

  it('renders one file target and forwards its path when clicked', () => {
    const filePath = 'D:\\CS\\deepseek-harness-vscode\\.test-workspace\\hello.txt'
    const onOpenLink = vi.fn()
    const tool: ToolCallView = {
      id: 'clickable-file-target',
      name: 'edit',
      title: 'Edit',
      category: 'tool',
      status: 'completed',
      metadata: {},
      presentation: {
        phase: 'result',
        card: 'diff',
        diffs: [{ path: filePath, oldText: 'Part A', newText: 'Phase 1' }],
      },
    }

    render(createElement(ToolRow, { tool, expanded: true, onToggle: vi.fn(), onOpenLink }))

    const target = document.querySelector<HTMLButtonElement>('.dsh-tool-row__target')
    expect(target?.textContent).toBe(filePath)
    expect(target?.querySelector('.dsh-tool-row__target-href')).toBeNull()
    fireEvent.click(target!)
    expect(onOpenLink).toHaveBeenCalledOnce()
    expect(onOpenLink).toHaveBeenCalledWith(filePath)
  })
})
