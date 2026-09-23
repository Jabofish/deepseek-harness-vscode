// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownContent } from './MarkdownContent.js'
import { getWebviewHighlighter } from './shiki.js'

describe('MarkdownContent', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  /**
   * Fetching the real Shiki bundle and one grammar is CPU-bound. Warm the shared
   * highlighter outside the assertion window so a loaded host cannot turn the
   * lazy highlight path into a timeout flake.
   */
  async function warmHighlighter(): Promise<void> {
    await (await getWebviewHighlighter()).loadLanguage('typescript')
  }

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
    const link = screen.getByRole('link', { name: 'Docs' })
    expect(link.getAttribute('href')).toBeNull()
    expect(link.getAttribute('data-dsh-link')).toBe('https://example.com')
    expect(container.querySelector('pre')).toBeNull()
  })

  it('requires an explicit gesture before delegating a Markdown link', () => {
    const onOpenLink = vi.fn()
    render(<MarkdownContent markdown={'[Docs](https://example.com)'} onOpenLink={onOpenLink} />)

    const link = screen.getByRole('link', { name: 'Docs' })
    expect(onOpenLink).not.toHaveBeenCalled()
    fireEvent.click(link)
    expect(onOpenLink).toHaveBeenCalledOnce()
    expect(onOpenLink).toHaveBeenCalledWith('https://example.com')
  })

  it('does not allow raw HTML or remote image tags from model output', () => {
    const { container } = render(
      <MarkdownContent markdown={'<script>alert(1)</script>\n\n![secret](https://example.com/secret.png)'} />,
    )

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })

  it('treats soft-wrapped model output as paragraph text', () => {
    const { container } = render(
      <MarkdownContent markdown={'这是一行被模型软换行的内容\n这里应该继续属于同一段。'} />,
    )

    const paragraph = container.querySelector('p')
    expect(paragraph?.querySelector('br')).toBeNull()
    expect(paragraph?.textContent).toContain('这里应该继续属于同一段。')
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

  it('keeps the copy action fixed while wide tables scroll horizontally', async () => {
    const { container } = render(
      <MarkdownContent
        markdown={[
          '| A | B | C | D |',
          '| --- | --- | --- | --- |',
          '| 1 | 2 | 3 | 4 |',
          '',
          '> | A | B | C | D |',
          '> | --- | --- | --- | --- |',
          '> | 1 | 2 | 3 | 4 |',
        ].join('\n')}
      />,
    )

    await waitFor(() => {
      expect(container.querySelectorAll('.dsh-markdown__copy-region--table-wide')).toHaveLength(1)
      expect(container.querySelectorAll('.dsh-markdown__copy-region--table-fill')).toHaveLength(1)
    })
    const wide = container.querySelector<HTMLElement>('.dsh-markdown__copy-region--table-wide')
    expect(wide).not.toBeNull()
    const scrollPort = wide?.querySelector<HTMLElement>('.dsh-markdown__table-scroll')
    const copyButton = wide?.querySelector<HTMLButtonElement>('.dsh-markdown__copy-button')
    expect(scrollPort?.getAttribute('tabindex')).toBe('0')
    expect(scrollPort?.querySelector('table')).not.toBeNull()
    expect(copyButton).not.toBeNull()
    expect(scrollPort?.contains(copyButton ?? null)).toBe(false)
    expect(wide?.contains(copyButton ?? null)).toBe(true)
  })

  it('turns unique produced-file mentions into safe open actions', async () => {
    const onOpenLink = vi.fn()
    const { container } = render(
      <MarkdownContent
        markdown={'Created `report.html` and `style.css`; the second name is ambiguous.'}
        producedFiles={['site/report.html', 'a/style.css', 'b/style.css']}
        onOpenLink={onOpenLink}
      />,
    )

    const link = await screen.findByRole('button', { name: 'Open site/report.html' })
    expect(link.textContent).toBe('report.html')
    expect(link.getAttribute('title')).toBe('site/report.html')
    expect(link.classList.contains('dsh-inline-reference')).toBe(true)
    expect(screen.getByText('style.css')).toBeDefined()
    expect(screen.queryByRole('button', { name: /style\.css/u })).toBeNull()
    fireEvent.click(link)
    expect(onOpenLink).toHaveBeenCalledWith('site/report.html')
    expect(container.querySelectorAll('.dsh-inline-reference')).toHaveLength(1)
  })

  it('renders inline and display dollar math through KaTeX', async () => {
    const { container } = render(
      <MarkdownContent markdown={'Inline $a^2+b^2=c^2$\n\n$$\\int_0^1 x^2 dx$$'} />,
    )

    await waitFor(() => expect(container.querySelectorAll('.katex')).toHaveLength(2))
    expect(container.querySelector('.katex-display')).not.toBeNull()
    expect(container.textContent).toContain('a')
  })

  it('lazily highlights a fenced language with light and dark variants', async () => {
    await warmHighlighter()
    const { container } = render(
      <MarkdownContent markdown={'```typescript\nconst answer: number = 42\n```'} />,
    )

    await waitFor(() => expect(container.querySelector('pre.shiki')).not.toBeNull(), { timeout: 5_000 })
    expect(container.textContent).toContain('const answer')
    expect(container.querySelectorAll('.shiki .line').length).toBeGreaterThan(0)
    const highlighted = container.querySelector('pre.shiki')
    expect(highlighted?.className).toContain('github-light-default')
    expect(highlighted?.className).toContain('github-dark-default')
    expect(highlighted?.getAttribute('style')).toBeNull()
    expect(highlighted?.querySelector('[style*="light-dark("]')).not.toBeNull()
  })

  it('renders correctly labeled HTML and Python fences with token colors', async () => {
    const highlighter = await getWebviewHighlighter()
    await Promise.all([highlighter.loadLanguage('html'), highlighter.loadLanguage('python')])
    const { container } = render(
      <MarkdownContent
        markdown={[
          '```html',
          '<!DOCTYPE html>',
          '<html><body>Hello</body></html>',
          '```',
          '',
          '```python',
          'def animate():',
          '    return True',
          '```',
        ].join('\n')}
      />,
    )

    await waitFor(() => expect(container.querySelectorAll('pre.shiki')).toHaveLength(2), {
      timeout: 5_000,
    })
    expect(container.querySelectorAll('pre.shiki [style*="light-dark("]').length).toBeGreaterThan(0)
  })

  it('defers copy controls until a streaming message reaches its terminal render', async () => {
    const markdown = ['```ts', 'const value = 1', '```'].join('\n')
    const view = render(<MarkdownContent markdown={markdown} streaming />)

    expect(view.container.querySelector('.dsh-markdown__copy-region')).toBeNull()

    view.rerender(<MarkdownContent markdown={markdown} />)
    expect(await screen.findByRole('button', { name: 'Copy' })).toBeDefined()
  })

  it('keeps completed streaming blocks in a frozen region', () => {
    const { container, rerender } = render(
      <MarkdownContent streaming markdown={'First paragraph.\n\nSecond paragraph is still growing'} />,
    )

    expect(container.querySelector('[data-dsh-markdown-frozen="true"]')?.textContent).toContain(
      'First paragraph.',
    )
    expect(container.querySelector('[data-dsh-markdown-tail="true"]')?.textContent).toContain(
      'Second paragraph',
    )

    rerender(
      <MarkdownContent streaming markdown={'First paragraph.\n\nSecond paragraph is still growing now'} />,
    )
    expect(container.querySelector('[data-dsh-markdown-frozen="true"]')?.textContent).toContain(
      'First paragraph.',
    )
    expect(container.querySelector('[data-dsh-markdown-tail="true"]')?.textContent).toContain('growing now')
  })

  it('eventually catches up long streaming Markdown after deferred renders', async () => {
    const initial = 'word '.repeat(1_000).trim()
    const view = render(<MarkdownContent streaming markdown={initial} />)

    view.rerender(<MarkdownContent streaming markdown={`${initial} latest`} />)

    await waitFor(() => expect(view.container.textContent).toContain('latest'))
  })
})
