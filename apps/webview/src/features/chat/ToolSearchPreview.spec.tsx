// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolSearchRenderProps } from '@dsh-vscode/ui'
import { ToolSearchPreview } from './ToolSearchPreview.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

type SearchPathsView = Extract<ToolSearchRenderProps['view'], { readonly shape: 'paths' }>
type SearchMatchesView = Extract<ToolSearchRenderProps['view'], { readonly shape: 'matches' }>

function searchProps(
  overrides: Partial<Omit<SearchPathsView, 'phase' | 'card' | 'shape'>> & { readonly recovery?: string } = {},
): ToolSearchRenderProps {
  const { recovery, ...view } = overrides
  return {
    view: {
      phase: 'result',
      card: 'search',
      shape: 'paths',
      paths: ['src/feature.ts'],
      truncated: false,
      total: 1,
      ...view,
    },
    ...(recovery === undefined ? {} : { recovery }),
  }
}

function matchesProps(
  overrides: Partial<Omit<SearchMatchesView, 'phase' | 'card' | 'shape'>> = {},
): ToolSearchRenderProps {
  return {
    view: {
      phase: 'result',
      card: 'search',
      shape: 'matches',
      files: [],
      truncated: false,
      total: 0,
      ...overrides,
    },
  }
}

describe('ToolSearchPreview', () => {
  it('renders and copies a truncated flat path result', async () => {
    const paths = Array.from({ length: 18 }, (_, index) => `src/feature-${index + 1}.ts`)
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { container } = render(
      <ToolSearchPreview {...searchProps({ paths, truncated: true, total: 24 })} />,
    )

    expect(container.querySelector('[data-search="paths"]')).not.toBeNull()
    expect(container.querySelectorAll('.dsh-tool-search-preview__line')).toHaveLength(16)
    expect(container.textContent).toContain('Showing 18 of 24 paths')
    expect(container.textContent).toContain('src/feature-1.ts')
    expect(container.textContent).toContain('src/feature-18.ts')
    expect(container.textContent).not.toContain('src/feature-9.ts')
    expect(screen.getByRole('button', { name: 'Show 2 more search rows' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(paths.join('\n')))
  })

  it('groups matches by file and lets each file header collapse independently', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { container } = render(
      <ToolSearchPreview
        {...matchesProps({
          files: [
            {
              path: 'src/a.ts',
              matches: [
                { lineNumber: 2, line: 'answer' },
                { lineNumber: 8, line: 'answer again' },
              ],
            },
            { path: 'src/b.ts', matches: [{ lineNumber: 4, line: 'answer here' }] },
          ],
          total: 3,
        })}
      />,
    )

    expect(container.textContent).toContain('3 matches · 2 files')
    expect(container.querySelectorAll('.dsh-tool-search-preview__file-header')).toHaveLength(2)
    expect(container.querySelectorAll('.dsh-tool-search-preview__line')).toHaveLength(3)
    expect(screen.getByText('answer again')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }))
    expect(container.querySelectorAll('.dsh-tool-search-preview__line')).toHaveLength(1)
    expect(screen.queryByText('answer again')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }))
    expect(container.querySelectorAll('.dsh-tool-search-preview__line')).toHaveLength(3)
    expect(screen.getByText('answer again')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'src/a.ts\n2: answer\n8: answer again\n\nsrc/b.ts\n4: answer here',
      ),
    )
  })

  it('restores the file header when a fold tail starts inside its matches', () => {
    const matches = Array.from({ length: 10 }, (_, index) => ({
      lineNumber: index + 1,
      line: `match ${index + 1}`,
    }))
    const laterMatches = Array.from({ length: 10 }, (_, index) => ({
      lineNumber: index + 11,
      line: `match ${index + 11}`,
    }))
    const { container } = render(
      <ToolSearchPreview
        {...matchesProps({
          files: [
            { path: 'src/first.ts', matches },
            { path: 'src/large.ts', matches: laterMatches },
          ],
          total: 20,
        })}
      />,
    )

    expect(container.querySelectorAll('.dsh-tool-search-preview__file-header')).toHaveLength(2)
    expect(container.querySelectorAll('.dsh-tool-search-preview__line')).toHaveLength(14)
    expect(screen.getByRole('button', { name: 'Show 6 more search rows' })).toBeDefined()
  })

  it('shows an explicit empty result without offering an empty copy', () => {
    const { container } = render(<ToolSearchPreview {...searchProps({ paths: [], total: 0 })} />)

    expect(container.textContent).toContain('No results')
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()
  })

  it('keeps the capped result text, whose tail names where the dropped rows went', () => {
    const footer = 'Full glob result stored at: .dsh/spill/glob.txt. Read the file for the complete list.'
    const { container } = render(
      <ToolSearchPreview
        {...searchProps({
          paths: ['src/feature.ts'],
          truncated: true,
          total: 900,
          recovery: `src/feature.ts\n(${footer})`,
        })}
      />,
    )

    const recovery = container.querySelector('.dsh-tool-search-preview__recovery')
    expect(recovery?.textContent).toContain(footer)
  })

  it('renders no recovery block when the card already holds every row', () => {
    const { container } = render(<ToolSearchPreview {...searchProps()} />)

    expect(container.querySelector('.dsh-tool-search-preview__recovery')).toBeNull()
  })
})
