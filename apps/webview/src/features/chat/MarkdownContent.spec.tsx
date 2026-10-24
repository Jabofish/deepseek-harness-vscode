// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { MarkdownContent } from './MarkdownContent.js'
import {
  cachedCodeHighlight,
  getWebviewHighlighter,
  requestCodeHighlight,
  subscribeCodeHighlights,
} from './shiki.js'

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

  it.each([
    { markdown: '[Docs](https://example.com)', name: 'Docs', href: 'https://example.com' },
    { markdown: '[.gitignore](.gitignore)', name: '.gitignore', href: '.gitignore' },
  ])('requires an explicit gesture before delegating $markdown', ({ markdown, name, href }) => {
    const onOpenLink = vi.fn()
    render(<MarkdownContent markdown={markdown} onOpenLink={onOpenLink} />)

    const link = screen.getByRole('link', { name })
    expect(onOpenLink).not.toHaveBeenCalled()
    fireEvent.click(link)
    expect(onOpenLink).toHaveBeenCalledOnce()
    expect(onOpenLink).toHaveBeenCalledWith(href)
  })

  it.each([false, true])('opens complete links wrapped in inline code, streaming=%s', (streaming) => {
    const onOpenLink = vi.fn()
    render(
      <MarkdownContent
        markdown={'1. 要不要提交 `[.gitignore](.gitignore)`？\n\n`[Docs](https://example.com/docs)`'}
        streaming={streaming}
        onOpenLink={onOpenLink}
      />,
    )

    const file = screen.getByRole('link', { name: '.gitignore' })
    const docs = screen.getByRole('link', { name: 'Docs' })
    expect(file.getAttribute('href')).toBeNull()
    expect(docs.getAttribute('href')).toBeNull()
    expect(onOpenLink).not.toHaveBeenCalled()
    fireEvent.click(file)
    expect(onOpenLink).toHaveBeenLastCalledWith('.gitignore')
    fireEvent.keyDown(docs, { key: 'Enter' })
    expect(onOpenLink).toHaveBeenLastCalledWith('https://example.com/docs')
    fireEvent.keyDown(file, { key: ' ' })
    expect(onOpenLink).toHaveBeenCalledTimes(3)
    expect(onOpenLink).toHaveBeenLastCalledWith('.gitignore')
  })

  it.each(['[`report.html`](docs/source.html)', '`[report.html](docs/source.html)`'])(
    'preserves an explicit link target when its code label is also a produced file: %s',
    (markdown) => {
      const onOpenLink = vi.fn()
      const { container } = render(
        <MarkdownContent markdown={markdown} producedFiles={['report.html']} onOpenLink={onOpenLink} />,
      )

      const link = screen.getByRole('link', { name: 'report.html' })
      expect(container.querySelector('.dsh-inline-reference')).toBeNull()
      fireEvent.click(link.querySelector('code') ?? link)
      expect(onOpenLink).toHaveBeenCalledOnce()
      expect(onOpenLink).toHaveBeenCalledWith('docs/source.html')
    },
  )

  it('keeps fenced examples, code expressions, multiple links and unsafe links as code', () => {
    const onOpenLink = vi.fn()
    const examples = [
      '`print("[Docs](https://example.com)")`',
      '`[A](a.md) [B](b.md)`',
      '`[Run](javascript:alert(1))`',
      '```text\n[.gitignore](.gitignore)\n```',
    ]
    const { container } = render(<MarkdownContent markdown={examples.join('\n\n')} onOpenLink={onOpenLink} />)

    expect(screen.queryByRole('link')).toBeNull()
    expect(container.querySelector('pre code')?.textContent).toContain('[.gitignore](.gitignore)')
    expect(container.querySelectorAll('code')).toHaveLength(4)
    fireEvent.click(screen.getByText('[Run](javascript:alert(1))'))
    expect(onOpenLink).not.toHaveBeenCalled()
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
    // Lazy highlighting can replace the toolbar while clipboard completion is awaited.
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Table' })).getByRole('button', { name: 'Copy' }),
    )
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
    const filled = container.querySelector('.dsh-markdown__copy-region--table-fill')
    const filledScrollPort = filled?.querySelector('.dsh-markdown__table-scroll')
    expect(filledScrollPort?.getAttribute('tabindex')).toBe('0')
    expect(filledScrollPort?.getAttribute('role')).toBe('region')
    expect(filledScrollPort?.contains(filled?.querySelector('button') ?? null)).toBe(false)
  })

  it('labels highlighted code and tables without placing metadata inside copied content', async () => {
    await warmHighlighter()
    const { container } = render(
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
    expect(container.querySelectorAll('.dsh-markdown__block-toolbar')).toHaveLength(2)
  })

  it('keeps unknown language labels bounded and treats markup-like fence metadata as text', async () => {
    render(
      <MarkdownContent markdown={'```custom-dsl\nvalue\n```\n\n```<img-onerror=alert(1)>\nplain\n```'} />,
    )
    expect(await screen.findByRole('group', { name: 'Code block: custom-dsl' })).toBeDefined()
    expect(screen.getByRole('group', { name: 'Code block: Text' })).toBeDefined()
    expect(document.querySelector('img')).toBeNull()
  })

  it('releases copy portals on streaming changes and Strict Mode unmount without nested-root warnings', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const view = render(
        <StrictMode>
          <MarkdownContent markdown={'```\nfirst\n```'} />
        </StrictMode>,
      )
      expect(await screen.findByRole('group', { name: 'Code block: Text' })).toBeDefined()
      view.rerender(
        <StrictMode>
          <MarkdownContent markdown={'```\nsecond\n```'} streaming />
        </StrictMode>,
      )
      await waitFor(() => expect(screen.queryByRole('group', { name: 'Code block: Text' })).toBeNull())
      view.rerender(
        <StrictMode>
          <MarkdownContent markdown={'```\nsecond\n```'} />
        </StrictMode>,
      )
      expect(await screen.findByRole('group', { name: 'Code block: Text' })).toBeDefined()
      view.unmount()
      expect(document.querySelector('.dsh-markdown__copy-mount')).toBeNull()
      expect(error.mock.calls.flat().join(' ')).not.toMatch(/synchronously unmount|Maximum update depth/u)
    } finally {
      error.mockRestore()
    }
  })

  it('turns unique produced-file mentions into safe open actions', async () => {
    await warmHighlighter()
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

    // Completion in another message invalidates the shared highlight store.
    // This message's HTML stays identical, so its file actions must survive.
    const unrelatedCode = 'const producedMentionRefresh = 1'
    await act(async () => {
      await new Promise<void>((resolve) => {
        if (cachedCodeHighlight('typescript', unrelatedCode) !== undefined) {
          resolve()
          return
        }
        const unsubscribe = subscribeCodeHighlights(() => {
          if (cachedCodeHighlight('typescript', unrelatedCode) === undefined) return
          unsubscribe()
          resolve()
        })
        requestCodeHighlight('typescript', unrelatedCode)
      })
    })
    expect(container.querySelectorAll('.dsh-inline-reference')).toHaveLength(1)
    expect(link.isConnected).toBe(true)
    fireEvent.click(link)
    expect(onOpenLink).toHaveBeenCalledTimes(2)
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

  it('highlights Rust and PHP fences in the chat', async () => {
    const highlighter = await getWebviewHighlighter()
    await Promise.all([highlighter.loadLanguage('rust'), highlighter.loadLanguage('php')])
    const { container } = render(
      <MarkdownContent
        markdown={[
          '```rust',
          'fn main() { println!("Hello, world!"); }',
          '```',
          '',
          '```php',
          '<?php echo "Hello, world!"; ?>',
          '```',
        ].join('\n')}
      />,
    )

    await waitFor(() => expect(container.querySelectorAll('pre.shiki')).toHaveLength(2), {
      timeout: 5_000,
    })
    for (const block of container.querySelectorAll('pre.shiki')) {
      expect(block.querySelector('[style*="light-dark("]')).not.toBeNull()
    }
  })

  it('defers copy controls until a streaming message reaches its terminal render', async () => {
    const markdown = ['```ts', 'const value = 1', '```'].join('\n')
    const view = render(<MarkdownContent markdown={markdown} streaming />)

    expect(view.container.querySelector('.dsh-markdown__copy-region')).toBeNull()

    view.rerender(<MarkdownContent markdown={markdown} />)
    expect(await screen.findByRole('button', { name: 'Copy' })).toBeDefined()
  })

  it('highlights a closed fence while the message is still streaming', async () => {
    await warmHighlighter()
    const view = render(
      <MarkdownContent streaming markdown={'Intro\n\n```typescript\nconst first = 1\n```\n\nStill writ'} />,
    )

    await waitFor(
      () =>
        expect(view.container.querySelector('[data-dsh-markdown-frozen="true"] pre.shiki')).not.toBeNull(),
      { timeout: 5_000 },
    )
    expect(view.container.querySelector('[data-dsh-markdown-tail="true"]')?.textContent).toContain(
      'Still writ',
    )
  })

  it('keeps completed lines highlighted while the rest of the fence is still written', async () => {
    await warmHighlighter()
    const view = render(<MarkdownContent streaming markdown={'# Title\n\n```typescript\nconst first = 1'} />)
    expect(view.container.querySelector('pre.shiki')).toBeNull()

    view.rerender(<MarkdownContent streaming markdown={'# Title\n\n```typescript\nconst first = 1\n'} />)
    await waitFor(() => expect(view.container.querySelector('pre.shiki')).not.toBeNull(), {
      timeout: 5_000,
    })
    expect(view.container.querySelector('pre.shiki')?.textContent).toBe('const first = 1\n')

    // The in-progress line is shown immediately and must not drop the colors
    // of the lines that are already complete.
    view.rerender(
      <MarkdownContent streaming markdown={'# Title\n\n```typescript\nconst first = 1\nlet second = '} />,
    )
    const block = view.container.querySelector('pre.shiki')
    expect(block?.textContent).toBe('const first = 1\nlet second = ')
    expect(block?.querySelector('.line')?.textContent).toBe('const first = 1')
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
    const frozenParagraph = container.querySelector('[data-dsh-markdown-frozen="true"] p')

    rerender(
      <MarkdownContent streaming markdown={'First paragraph.\n\nSecond paragraph is still growing now'} />,
    )
    expect(container.querySelector('[data-dsh-markdown-frozen="true"]')?.textContent).toContain(
      'First paragraph.',
    )
    expect(container.querySelector('[data-dsh-markdown-tail="true"]')?.textContent).toContain('growing now')
    expect(container.querySelector('[data-dsh-markdown-frozen="true"] p')).toBe(frozenParagraph)
  })

  it('eventually catches up long streaming Markdown after deferred renders', async () => {
    const initial = 'word '.repeat(1_000).trim()
    const view = render(<MarkdownContent streaming markdown={initial} />)

    view.rerender(<MarkdownContent streaming markdown={`${initial} latest`} />)

    await waitFor(() => expect(view.container.textContent).toContain('latest'))
  })
})
