// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MarkdownContent } from './MarkdownContent.js'

describe('MarkdownContent', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders conversation Markdown as structured content', () => {
    render(
      <MarkdownContent
        markdown={
          '# Release notes\n\n**Ready** with `pnpm check`.\n\n- stable\n- readable\n\n[Docs](https://example.com)'
        }
      />,
    )

    expect(screen.getByRole('heading', { name: 'Release notes' })).toBeDefined()
    expect(screen.getByText('Ready')).toBeDefined()
    expect(screen.getByText('pnpm check')).toBeDefined()
    expect(screen.getByRole('list')).toBeDefined()
    const link = screen.getByRole('link', { name: 'Docs' })
    expect(link.getAttribute('href')).toBeNull()
  })

  it.each([
    { markdown: '[Docs](https://example.com)', name: 'Docs', href: 'https://example.com' },
    { markdown: '[.gitignore](.gitignore)', name: '.gitignore', href: '.gitignore' },
  ])('requires an explicit gesture before delegating $markdown', ({ markdown, name, href }) => {
    const onOpenLink = vi.fn()
    render(<MarkdownContent markdown={markdown} onOpenLink={onOpenLink} />)

    const link = screen.getByRole('link', { name })
    expect(onOpenLink).not.toHaveBeenCalled()
    fireEvent.click(link)
    expect(onOpenLink).toHaveBeenCalledWith(href)
  })

  it.each(['[`report.html`](docs/source.html)', '`[report.html](docs/source.html)`'])(
    'preserves an explicit link target when its code label is also a produced file: %s',
    (markdown) => {
      const onOpenLink = vi.fn()
      render(<MarkdownContent markdown={markdown} producedFiles={['report.html']} onOpenLink={onOpenLink} />)

      const link = screen.getByRole('link', { name: 'report.html' })
      fireEvent.click(link.querySelector('code') ?? link)
      expect(onOpenLink).toHaveBeenCalledWith('docs/source.html')
    },
  )

  it('does not allow raw HTML or remote image tags from model output', () => {
    const { container } = render(
      <MarkdownContent markdown={'<script>alert(1)</script>\n\n![secret](https://example.com/secret.png)'} />,
    )

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })

  it('labels highlighted code and tables without placing metadata inside copied content', async () => {
    render(
      <MarkdownContent
        markdown={
          '```ts\nconst value = 1\nconst next = 2\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'
        }
      />,
    )
    const toolbar = await screen.findByRole('group', { name: 'Code block: typescript' })
    expect(toolbar.textContent).toContain('Lines: 2')
    const code = screen.getByRole('region', { name: 'Code block: typescript' })
    expect(code.getAttribute('tabindex')).toBe('0')
    expect(code.textContent).toBe('const value = 1\nconst next = 2\n')
    expect(screen.getByRole('group', { name: 'Table' }).textContent).toContain('Rows: 2 · Columns: 2')
  })

  it('keeps unknown language labels bounded and treats markup-like fence metadata as text', async () => {
    render(
      <MarkdownContent markdown={'```custom-dsl\nvalue\n```\n\n```<img-onerror=alert(1)>\nplain\n```'} />,
    )
    expect(await screen.findByRole('group', { name: 'Code block: custom-dsl' })).toBeDefined()
    expect(screen.getByRole('group', { name: 'Code block: Text' })).toBeDefined()
    expect(document.querySelector('img')).toBeNull()
  })

  it('opens a unique produced-file mention and leaves an ambiguous mention as text', () => {
    const onOpenLink = vi.fn()
    render(
      <MarkdownContent
        markdown={'Created `report.html` and `style.css`; the second name is ambiguous.'}
        producedFiles={['site/report.html', 'a/style.css', 'b/style.css']}
        onOpenLink={onOpenLink}
      />,
    )
    const link = screen.getByRole('button', { name: 'Open site/report.html' })
    expect(link.textContent).toBe('report.html')
    expect(screen.getByText('style.css')).toBeDefined()
    expect(screen.queryByRole('button', { name: /style\.css/u })).toBeNull()
    fireEvent.click(link)
    expect(onOpenLink).toHaveBeenCalledWith('site/report.html')
  })
})
