// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownContent } from './MarkdownContent.js'

describe('MarkdownContent', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders conversation Markdown as structured content', () => {
    const { container } = render(
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
    expect(screen.getByRole('link', { name: 'Docs' }).getAttribute('href')).toBe('https://example.com')
    expect(container.querySelector('pre')).toBeNull()
  })

  it('does not allow raw HTML or remote image tags from model output', () => {
    const { container } = render(
      <MarkdownContent markdown={'<script>alert(1)</script>\n\n![secret](https://example.com/secret.png)'} />,
    )

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })

  it('adds compact copy controls to fenced code and tables', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { container } = render(
      <MarkdownContent
        markdown={[
          '```ts',
          'const value = 1',
          '```',
          '',
          '| Field | Value |',
          '| --- | --- |',
          '| one | two |',
        ].join('\n')}
      />,
    )

    const buttons = await screen.findAllByRole('button', { name: 'Copy' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0]!)
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(container.querySelector('pre')?.textContent ?? ''),
    )
    fireEvent.click(buttons[1]!)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Field\tValue\none\ttwo'))
  })

  it('turns unique produced-file mentions into safe open actions', async () => {
    const onOpenLink = vi.fn()
    render(
      <MarkdownContent
        markdown={'Created `report.html` and `style.css`; the second name is ambiguous.'}
        producedFiles={['site/report.html', 'a/style.css', 'b/style.css']}
        onOpenLink={onOpenLink}
      />,
    )

    const link = await screen.findByRole('button', { name: 'Open site/report.html' })
    expect(link.textContent).toBe('report.html')
    expect(link.getAttribute('title')).toBe('site/report.html')
    expect(screen.getByText('style.css')).toBeDefined()
    expect(screen.queryByRole('button', { name: /style\.css/u })).toBeNull()
    fireEvent.click(link)
    expect(onOpenLink).toHaveBeenCalledWith('site/report.html')
  })

  it('renders inline and display dollar math through KaTeX', async () => {
    const { container } = render(
      <MarkdownContent markdown={'Inline $a^2+b^2=c^2$\n\n$$\\int_0^1 x^2 dx$$'} />,
    )

    await waitFor(() => expect(container.querySelectorAll('.katex')).toHaveLength(2))
    expect(container.querySelector('.katex-display')).not.toBeNull()
    expect(container.textContent).toContain('a')
  })

  it('lazily highlights a fenced language and preserves the source text', async () => {
    const { container } = render(
      <MarkdownContent markdown={'```typescript\nconst answer: number = 42\n```'} />,
    )

    await waitFor(() => expect(container.querySelector('pre.shiki')).not.toBeNull())
    expect(container.textContent).toContain('const answer')
    expect(container.querySelectorAll('.shiki .line').length).toBeGreaterThan(0)
  })

  it('keeps completed streaming blocks in a frozen region', () => {
    const { container } = render(
      <MarkdownContent streaming markdown={'First paragraph.\n\nSecond paragraph is still growing'} />,
    )

    expect(container.querySelector('[data-dsh-markdown-frozen="true"]')?.textContent).toContain(
      'First paragraph.',
    )
    expect(container.querySelector('[data-dsh-markdown-tail="true"]')?.textContent).toContain(
      'Second paragraph',
    )
  })
})
