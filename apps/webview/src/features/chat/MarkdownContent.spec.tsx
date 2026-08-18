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
})
