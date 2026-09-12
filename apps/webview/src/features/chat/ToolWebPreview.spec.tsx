// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolWebRenderProps } from '@dsh-vscode/ui'
import { ToolWebPreview } from './ToolWebPreview.js'

afterEach(() => cleanup())

type WebSearchView = Extract<ToolWebRenderProps['view'], { readonly kind: 'search' }>
type WebFetchView = Extract<ToolWebRenderProps['view'], { readonly kind: 'fetch' }>

function searchProps(
  overrides: Partial<Omit<WebSearchView, 'phase' | 'card' | 'kind'>> = {},
): ToolWebRenderProps {
  return {
    view: {
      phase: 'result',
      card: 'web',
      kind: 'search',
      sources: [],
      truncated: false,
      ...overrides,
    },
  }
}

function fetchProps(
  overrides: Partial<Omit<WebFetchView, 'phase' | 'card' | 'kind'>> = {},
): ToolWebRenderProps {
  return {
    view: {
      phase: 'result',
      card: 'web',
      kind: 'fetch',
      url: 'https://example.test/page',
      statusCode: 200,
      truncated: false,
      ...overrides,
    },
  }
}

describe('ToolWebPreview', () => {
  it('renders sanitized Markdown answers, numbered sources, and host-only source actions', () => {
    const onOpenLink = vi.fn()
    const { container } = render(
      <ToolWebPreview
        {...searchProps({
          answer: '**Answer**',
          sources: [
            {
              url: 'https://docs.example.test/guide',
              title: 'Documentation',
              snippet: 'A short excerpt',
              publishedAt: '2026-09-12',
            },
          ],
          truncated: true,
        })}
        onOpenLink={onOpenLink}
      />,
    )

    expect(container.querySelector('[data-web="search"]')).not.toBeNull()
    expect(screen.getByText('Answer').tagName).toBe('STRONG')
    expect(screen.getByRole('button', { name: 'Documentation' })).toBeDefined()
    expect(screen.getByText('A short excerpt')).toBeDefined()
    expect(screen.getByText('2026-09-12')).toBeDefined()
    expect(screen.getByText('Some sources are not shown.')).toBeDefined()
    expect(container.querySelector('[href]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Documentation' }))
    expect(onOpenLink).toHaveBeenCalledWith('https://docs.example.test/guide')
  })

  it('renders fetch status and delegates only validated HTTP URLs', () => {
    const onOpenLink = vi.fn()
    const { container } = render(
      <ToolWebPreview
        {...fetchProps({ url: 'https://example.test/missing', statusCode: 404, truncated: true })}
        onOpenLink={onOpenLink}
      />,
    )

    expect(container.querySelector('[data-web="fetch"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'https://example.test/missing' })).toBeDefined()
    expect(screen.getByText('HTTP 404')).toBeDefined()
    expect(screen.getByText('Content truncated')).toBeDefined()
    expect(container.querySelector('[href]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'https://example.test/missing' }))
    expect(onOpenLink).toHaveBeenCalledWith('https://example.test/missing')

    cleanup()
    render(
      <ToolWebPreview
        {...searchProps({ sources: [{ url: 'javascript:alert(1)', title: 'Unsafe' }] })}
        onOpenLink={onOpenLink}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Unsafe' })).toBeNull()
    expect(screen.getByText('Unsafe')).toBeDefined()
  })

  it('renders an explicit empty search result', () => {
    const { container } = render(<ToolWebPreview {...searchProps()} />)

    expect(container.textContent).toContain('No results')
    expect(container.querySelector('.dsh-tool-web-preview__sources')).toBeNull()
  })
})
