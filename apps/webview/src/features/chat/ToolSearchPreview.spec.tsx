// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolSearchRenderProps } from '@dsh-vscode/ui'
import { ToolSearchPreview } from './ToolSearchPreview.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

type SearchMatchesView = Extract<ToolSearchRenderProps['view'], { readonly shape: 'matches' }>

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
  it('renders every returned file and match without another expansion', () => {
    const matches = Array.from({ length: 10 }, (_, index) => ({
      lineNumber: index + 1,
      line: `match [${index + 1}]`,
    }))
    const laterMatches = Array.from({ length: 10 }, (_, index) => ({
      lineNumber: index + 11,
      line: `match [${index + 11}]`,
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

    expect(container.textContent).toContain('src/first.ts')
    expect(container.textContent).toContain('src/large.ts')
    for (const match of [...matches, ...laterMatches]) expect(container.textContent).toContain(match.line)
  })

  it('navigates to matched file lines and glob paths when onOpenLink is provided', () => {
    const onOpenLink = vi.fn()
    render(
      <ToolSearchPreview
        {...matchesProps({
          files: [{ path: 'src/app.ts', matches: [{ lineNumber: 42, line: 'const x = 1' }] }],
          total: 1,
        })}
        onOpenLink={onOpenLink}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /42:\s*const x = 1/u }))
    expect(onOpenLink).toHaveBeenCalledWith('src/app.ts#L42')

    cleanup()
    render(
      <ToolSearchPreview
        view={{
          phase: 'result',
          card: 'search',
          shape: 'paths',
          paths: ['src/index.ts'],
          total: 1,
          truncated: false,
        }}
        onOpenLink={onOpenLink}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'src/index.ts' }))
    expect(onOpenLink).toHaveBeenCalledWith('src/index.ts')
  })
})
